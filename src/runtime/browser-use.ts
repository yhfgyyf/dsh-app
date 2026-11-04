import * as profileFs from 'node:fs/promises';
import { join } from 'node:path';

type ExtensionUtils = {
  playwrightExtensionId: string;
  playwrightExtensionInstallUrl: string;
};
type ProfileIO = {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  access(path: string): Promise<void>;
};
type ExtensionProfile = { status: 'installed'; profile: string } | { status: 'missing' } | { status: 'unreadable'; code: string; path: string };

/** Match the pinned extension probe, preserving access failures instead of absence. */
async function inspectExtensionProfile(userDataDir: string, extensionId: string, io: ProfileIO): Promise<ExtensionProfile> {
  const optional = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  };
  const json = async (path: string) => {
    const text = await optional(() => io.readFile(path, 'utf8'));
    return text === undefined ? undefined : JSON.parse(text);
  };
  try {
    const entries = await optional(() => io.readdir(userDataDir));
    if (!entries) return { status: 'missing' };
    const lastUsed = (await json(join(userDataDir, 'Local State')))?.profile?.last_used;
    const profiles = entries.filter(entry => entry === 'Default' || /^Profile \d+$/.test(entry));
    profiles.sort((a, b) => a === b ? 0 : a === lastUsed ? -1 : b === lastUsed ? 1 : a === 'Default' ? -1 : b === 'Default' ? 1 : Number(a.slice(8)) - Number(b.slice(8)));
    for (const profile of profiles) {
      const directory = join(userDataDir, profile);
      if (await optional(async () => { await io.access(join(directory, 'Extensions', extensionId)); return true; })) return { status: 'installed', profile };
      for (const file of ['Preferences', 'Secure Preferences']) {
        const record = (await json(join(directory, file)))?.extensions?.settings?.[extensionId];
        if (record && typeof record === 'object' && Object.keys(record).length) return { status: 'installed', profile };
      }
    }
    return { status: 'missing' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'EPERM' || failure.code === 'EACCES') return { status: 'unreadable', code: failure.code, path: failure.path ?? userDataDir };
    throw error;
  }
}

/** Own the official provider's lifetime without restarting the DSH core. */
export async function createBrowserUseController(ctx: any, load: (id: string) => Promise<any>, playwrightCli?: string, extension?: ExtensionUtils, io: ProfileIO = profileFs) {
  if (!ctx.get('browserUse')) {
    const registry = await load('@deepseek-ai/dsh-browser-use');
    await ctx.plugin(registry.default ?? registry);
  }
  let provider: any;
  let pending: Promise<unknown> = Promise.resolve();
  return {
    configure(config: { enabled: boolean; executablePath?: string; userDataDir?: string; extensionToken?: string }): Promise<void> {
      const operation = pending.then(async () => {
        if (!config.enabled) {
          if (provider) { await provider.dispose(); provider = undefined; }
          return;
        }
        if (provider) return;
        if (ctx.get('browserUse')?.providerName) throw new Error('已有其他浏览器操作插件启用，请先停用该插件。');
        if (!config.executablePath) throw new Error('浏览器路径不可用。');
        if (config.userDataDir) {
          if (!playwrightCli || !extension) throw new Error('浏览器操作组件不可用。');
          const { mountSessionMcp } = await load('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp');
          const executablePath = config.executablePath, userDataDir = config.userDataDir;
          const extensionUtils = extension;
          const configuredProfile = await inspectExtensionProfile(userDataDir, extensionUtils.playwrightExtensionId, io);
          // The official extension keeps each MCP client's tabs separate while
          // using the existing profile's login state. Only an explicitly saved
          // credential may bypass confirmation; inherited tokens stay blocked.
          provider = await ctx.plugin({
            name: 'desktop-browser-use-playwright-extension',
            inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
            apply(scope: any) {
              // Only conclusive absence blocks the handshake. macOS may deny
              // profile inspection while the browser extension is available.
              scope.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
                if (!exec.name.startsWith('mcp__playwright-mcp__')) return next();
                const profile = configuredProfile.status === 'unreadable' ? configuredProfile : await inspectExtensionProfile(userDataDir, extensionUtils.playwrightExtensionId, io);
                if (profile.status === 'missing') {
                  throw new Error('请先由用户在当前浏览器安装并启用 Playwright Extension，再重试。安装地址：' + extensionUtils.playwrightExtensionInstallUrl);
                }
                try { return await next(); }
                catch (error) {
                  if (profile.status !== 'unreadable') throw error;
                  throw new Error(`浏览器扩展连接失败。系统拒绝读取浏览器资料目录（${profile.code}: ${profile.path}），无法通过文件确认扩展状态。请在浏览器中检查 Playwright Extension 是否启用并完成连接确认。原始错误：${error instanceof Error ? error.message : String(error)}`, { cause: error });
                }
              });
              const env = Object.fromEntries(Object.keys(process.env).filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_')).map(key => [key, '']));
              env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = config.extensionToken ?? '';
              mountSessionMcp(scope, {
                name: 'playwright-mcp', exclusive: false, command: process.execPath,
                // Without a custom profile path the explicit executable uses
                // the live extension relay without reading protected files.
                args: [playwrightCli, '--browser', 'chrome', '--extension', '--executable-path', executablePath, ...(configuredProfile.status === 'unreadable' ? [] : ['--user-data-dir', userDataDir])],
                env,
              });
            },
          });
          return;
        }
        // Retain the official isolated launch path for internal browser fixtures.
        provider = await ctx.plugin(await load('@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'), {
          mode: 'launch', headless: false, executablePath: config.executablePath,
        });
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
