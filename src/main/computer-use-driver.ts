import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
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
  capturePreview(args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult>;
  describe(signal: AbortSignal): Promise<unknown>;
  stop(): Promise<void>;
}

/** Signing can change binary bytes; packaging verifies the signed manifest. */
export async function verifyMacDriverPatch(runtimeRoot: string): Promise<void> {
  try {
    const directory = join(runtimeRoot, 'computer-use');
    const [pin, built] = await Promise.all(['native-patch.json', 'driver-build.json'].map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
    if (pin.patchId !== 'dsh-macos-foreground-v2' ||
      ['patchId', 'sourceCommit', 'sourceTree', 'patchSha256', 'cargoLockSha256', 'toolchain'].some(key => typeof pin[key] !== 'string' || pin[key] !== built[key])) throw new Error('Native patch metadata does not match');
  } catch (error) {
    throw new Error('macOS 电脑操作驱动缺少匹配的前台输入补丁，请运行 npm run setup:computer-use 后重新构建 App。', { cause: error });
  }
}

/** The native SDK supervises a private child over inherited pipes, without a listener. */
export class CuaComputerDriver implements ComputerDriver {
  private sdk?: Promise<DriverSdk>;
  private driver?: NativeDriver;
  private starting?: Promise<void>;
  private generation = 0;
  private stopping?: Promise<void>;
  private previewDriver?: CuaComputerDriver;
  pid?: number;
  get previewPid() { return this.previewDriver?.pid; }
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
      if (platform === 'darwin') await verifyMacDriverPatch(this.options.runtimeRoot);
      signal.throwIfAborted();
      if (generation !== this.generation) throw new Error('电脑操作启动已取消。');
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
    const { method, ...native } = args;
    const paste = name === 'type_text' && method === 'paste';
    const windowKeyboard = (this.options.platform ?? process.platform) === 'darwin' &&
      ['hotkey', 'press_key', 'type_text'].includes(name) && native.delivery_mode === 'foreground' &&
      typeof native.pid === 'number' && typeof native.window_id === 'number';
    if (paste && (!windowKeyboard || typeof native.text !== 'string')) throw new Error('粘贴输入需要 macOS 上的明确窗口、foreground 和 text。');
    if (windowKeyboard && name === 'hotkey') {
      const keys = native.keys;
      if (!Array.isArray(keys) || !keys.length || !keys.every(key => typeof key === 'string' && key.length > 0)) throw new Error('hotkey keys 必须是修饰键和一个普通按键组成的数组。');
      const modifiers = new Set(['cmd', 'command', 'shift', 'option', 'alt', 'ctrl', 'control', 'fn']);
      const chord = keys.map(key => key.toLowerCase());
      const base = chord.filter(key => !modifiers.has(key));
      if (base.length !== 1) throw new Error('hotkey keys 必须包含且只能包含一个普通按键。');
    }
    if (windowKeyboard && typeof native.x === 'number' && typeof native.y === 'number') {
      // Temporary activation can be restored before a canvas consumes input.
      await this.invoke('bring_to_front', { pid: native.pid, window_id: native.window_id }, signal);
      // Explicit coordinates request a real focus click. Omit them on subsequent
      // keys/pastes to preserve the editor's selection and existing focus.
      await this.invoke('click', { pid: native.pid, window_id: native.window_id, x: native.x, y: native.y, delivery_mode: 'foreground' }, signal);
      // Never let the native input focus a second time; its press_key pixel path
      // also falls back to PID delivery even when foreground was requested.
      delete native.x; delete native.y;
    }
    if (paste) {
      await this.invoke('clipboard_write', { text: native.text }, signal);
      const readback = await this.invoke('clipboard_read', { include_text: true }, signal);
      if (!readback.data || (readback.data as { text?: unknown }).text !== native.text) throw new Error('剪贴板读回与待输入文本不一致，未发送粘贴快捷键。');
      const { text: _text, delay_ms: _delay, ...target } = native;
      // Keep native strict AX focus where addressed; an unaddressed chord
      // preserves the existing selection within the guarded foreground window.
      const result = await this.invoke('hotkey', { ...target, keys: ['cmd', 'v'] }, signal);
      return { ...result, data: { ...(result.data as Record<string, unknown>), input_method: 'clipboard_paste' } };
    }
    return this.invoke(name, native, signal);
  }
  private async invoke(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> {
    signal.throwIfAborted();
    const result = await this.driver!.callTool(name, JSON.stringify(args), { signal });
    if (result.isError) throw new Error(`${result.errorCode ? result.errorCode + ': ' : ''}${result.text}`);
    return { text: result.text, data: result.structuredJson === undefined ? undefined : JSON.parse(result.structuredJson), images: result.images };
  }
  async describe(signal: AbortSignal): Promise<unknown> {
    await this.start(signal);
    return JSON.parse(await this.driver!.listToolsJson({ signal }));
  }
  /** Capture in a separate worker: native screenshot transforms are mutable. */
  async capturePreview(args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> {
    signal.throwIfAborted();
    if (this.stopping) throw new Error('电脑操作正在停止。');
    this.previewDriver ??= new CuaComputerDriver(this.options);
    return this.previewDriver.call('get_window_state', args, signal);
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.generation;
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      const driver = this.driver;
      const preview = this.previewDriver;
      this.driver = undefined;
      this.previewDriver = undefined;
      const errors: unknown[] = [];
      try { await preview?.stop(); } catch (error) { errors.push(error); }
      try {
        await driver?.shutdown({ signal: AbortSignal.timeout(10000) });
      }
      catch (error) { errors.push(error); }
      finally { driver?.uniffiDestroy?.(); this.pid = undefined; }
      if (errors.length) throw new AggregateError(errors, '电脑操作驱动停止失败。');
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
