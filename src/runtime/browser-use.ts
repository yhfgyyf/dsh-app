/** Own the official provider's lifetime without restarting the DSH core. */
export async function createBrowserUseController(ctx: any, load: (id: string) => Promise<any>) {
  if (!ctx.get('browserUse')) {
    const registry = await load('@deepseek-ai/dsh-browser-use');
    await ctx.plugin(registry.default ?? registry);
  }
  let provider: any;
  let pending: Promise<unknown> = Promise.resolve();
  return {
    configure(config: { enabled: boolean; executablePath?: string }): Promise<void> {
      const operation = pending.then(async () => {
        if (!config.enabled) {
          if (provider) { await provider.dispose(); provider = undefined; }
          return;
        }
        if (provider) return;
        if (ctx.get('browserUse')?.providerName) throw new Error('已有其他浏览器操作插件启用，请先停用该插件。');
        if (!config.executablePath) throw new Error('浏览器路径不可用。');
        provider = await ctx.plugin(await load('@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'), {
          mode: 'launch', headless: false, executablePath: config.executablePath,
        });
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
