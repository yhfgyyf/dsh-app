import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { COMPUTER_DRIVER_VERSION, type ComputerPermissions, type ComputerResult } from '../shared/computer-use.ts';

type NativeDriver = {
  metadata(options: { signal: AbortSignal }): Promise<{ driverVersion: string; pid: number }>;
  callTool(name: string, argumentsJson: string, options: { signal: AbortSignal }): Promise<{ text: string; images: ComputerResult['images']; structuredJson?: string; isError: boolean; errorCode?: string }>;
  listToolsJson(options: { signal: AbortSignal }): Promise<string>;
  shutdown(options: { signal: AbortSignal }): Promise<void>;
  uniffiDestroy?(): void;
};
type DriverSdk = {
  currentMacOsPermissionStatus(): { accessibility: boolean; screenRecording: boolean };
  requestMacOsPermissions(): { accessibility: boolean; screenRecording: boolean };
  CuaDriver: { createPrivateWorker(options: Record<string, unknown>): NativeDriver };
};

export interface ComputerDriver {
  permissions(prompt?: boolean): Promise<ComputerPermissions>;
  start(signal: AbortSignal): Promise<void>;
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult>;
  describe(signal: AbortSignal): Promise<unknown>;
  stop(): Promise<void>;
}

/** The native SDK supervises a private child over inherited pipes, without a listener. */
export class CuaComputerDriver implements ComputerDriver {
  private sdk?: Promise<DriverSdk>;
  private driver?: NativeDriver;
  private starting?: Promise<void>;
  private generation = 0;
  private stopping?: Promise<void>;
  pid?: number;
  private options: { runtimeRoot: string; hostBundleId: string; platform?: NodeJS.Platform };
  constructor(options: { runtimeRoot: string; hostBundleId: string; platform?: NodeJS.Platform }) { this.options = options; }
  private load(): Promise<DriverSdk> {
    return this.sdk ??= (async () => {
      return await import(pathToFileURL(join(this.options.runtimeRoot, 'computer-use/node_modules/@trycua/cua-driver/dist/index.js')).href) as DriverSdk;
    })();
  }
  async permissions(prompt = false): Promise<ComputerPermissions> {
    const platform = this.options.platform ?? process.platform;
    if (!['darwin', 'win32'].includes(platform)) return { supported: false, accessibility: false, screenRecording: false };
    const sdk = await this.load();
    if (platform === 'win32') return { supported: true, accessibility: true, screenRecording: true };
    const status = prompt ? sdk.requestMacOsPermissions() : sdk.currentMacOsPermissionStatus();
    return { supported: true, ...status };
  }
  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.stopping) throw new Error('电脑操作正在停止，请稍后重新开始。');
    if (this.driver && !this.starting) return;
    if (this.starting) return this.starting;
    const generation = this.generation;
    this.starting = (async () => {
      const permissions = await this.permissions();
      if (!permissions.supported || !permissions.accessibility || !permissions.screenRecording) throw new Error('请在 App 的电脑操作设置中授予辅助功能和屏幕录制权限。');
      const sdk = await this.load();
      signal.throwIfAborted();
      if (generation !== this.generation) throw new Error('电脑操作启动已取消。');
      const platform = this.options.platform ?? process.platform;
      const driver = sdk.CuaDriver.createPrivateWorker({
        binaryPath: join(this.options.runtimeRoot, 'computer-use/bin', platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'),
        hostBundleId: this.options.hostBundleId, startupTimeoutMs: 20000n, shutdownTimeoutMs: 5000n,
        inheritStderr: false,
        environment: [{ name: 'CUA_DRIVER_RS_TELEMETRY_ENABLED', value: 'false' }, { name: 'CUA_TELEMETRY_ENABLED', value: 'false' }],
        configuredDriver: { claudeCodeCompatibility: false, authorization: { allowedModes: [0], compatibilityMode: 0, unrestrictedAcknowledged: false, maxSessionTtlSeconds: 3600n, maxIdleTtlSeconds: 600n } },
      });
      this.driver = driver;
      try {
        const metadata = await driver.metadata({ signal });
        if (metadata.driverVersion !== COMPUTER_DRIVER_VERSION) throw new Error('电脑操作驱动版本与 App 不匹配。');
        this.pid = metadata.pid;
      } catch (error) {
        await driver.shutdown({ signal: AbortSignal.timeout(10000) }).finally(() => driver.uniffiDestroy?.());
        if (this.driver === driver) this.driver = undefined;
        this.pid = undefined;
        throw error;
      }
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> {
    await this.start(signal);
    signal.throwIfAborted();
    const result = await this.driver!.callTool(name, JSON.stringify(args), { signal });
    if (result.isError) throw new Error(`${result.errorCode ? result.errorCode + ': ' : ''}${result.text}`);
    return { text: result.text, data: result.structuredJson === undefined ? undefined : JSON.parse(result.structuredJson), images: result.images };
  }
  async describe(signal: AbortSignal): Promise<unknown> {
    await this.start(signal);
    return JSON.parse(await this.driver!.listToolsJson({ signal }));
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.generation;
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      const driver = this.driver;
      this.driver = undefined;
      try { await driver?.shutdown({ signal: AbortSignal.timeout(10000) }); }
      finally { driver?.uniffiDestroy?.(); this.pid = undefined; }
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
