/** Own the official provider's lifetime without restarting the DSH core. */
export async function createBrowserUseController(ctx: any, load: (id: string) => Promise<any>, playwrightCli?: string) {
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
          if (!playwrightCli) throw new Error('浏览器操作组件不可用。');
          const { mountSessionMcp } = await load('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp');
          const executablePath = config.executablePath, userDataDir = config.userDataDir;
          // The official extension keeps each MCP client's tabs separate while
          // using the existing profile's login state. Only an explicitly saved
          // credential may bypass confirmation; inherited tokens stay blocked.
          provider = await ctx.plugin({
            name: 'desktop-browser-use-playwright-extension',
            inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
            apply(scope: any) {
              const env = Object.fromEntries(Object.keys(process.env).filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_')).map(key => [key, '']));
              env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = config.extensionToken ?? '';
              mountSessionMcp(scope, {
                name: 'playwright-mcp', exclusive: false, command: process.execPath,
                args: [playwrightCli, '--browser', 'chrome', '--extension', '--executable-path', executablePath, '--user-data-dir', userDataDir],
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
