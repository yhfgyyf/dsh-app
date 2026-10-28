import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CollabRelayManager } from './collab-relays.ts';
import { PLUGIN_VERSION, type HostContext } from './collab-host.ts';

export const name = 'dsh-p2p-collab';
export const inject = ['connection', 'sessionController', 'sessionQuery', 'sessionPersistence', 'agents', 'desktopCollabBroker', 'webServer', 'appReady'];
type Context = HostContext & {
  connection: HostContext['connection'] & { authenticatedUrl(endpoint: string): string };
  webServer: { port: number };
  appReady: { onReady(listener: () => void): () => void };
};
export async function apply(ctx: Context) {
  const root = process.env.DSH_DESKTOP_RUNTIME_ROOT, home = process.env.DSH_DESKTOP_STATE_HOME ?? process.env.DSH_HOME;
  if (!root || !home) throw new Error('协作插件需要 DSH Desktop 的本机运行环境。');
  const runtimeRequire = createRequire(join(root, 'package.json')), require = createRequire(import.meta.url);
  const { deriveTurnTokenUsage } = await import(pathToFileURL(join(dirname(runtimeRequire.resolve('@deepseek-ai/dsh-token-meter/package.json')), 'lib/types/turn-usage.js')).href);
  const metadata = require('./package.json');
  const manager = new CollabRelayManager(home, ctx, deriveTurnTokenUsage, {
    appVersion: metadata.dshDesktopVersion ?? 'unknown', runtimeVersion: runtimeRequire('@deepseek-ai/dsh/package.json').version,
    pluginVersion: PLUGIN_VERSION, platform: process.platform, arch: process.arch,
  });
  let ready: Promise<void>;
  ctx.effect(() => {
    process.on('message', manager.capture);
    let disposed = false;
    let resolve!: () => void, reject!: (error: unknown) => void;
    ready = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
    void ready.catch(() => {});
    const unsubscribe = ctx.appReady.onReady(() => {
      if (disposed) return;
      const endpoint = `http://127.0.0.1:${ctx.webServer.port}`;
      void manager.start({ WebSocket: runtimeRequire('ws'), endpoint, launchUrl: ctx.connection.authenticatedUrl(endpoint) }).then(resolve, reject);
    });
    return () => { disposed = true; unsubscribe(); process.off('message', manager.capture); return manager.stop(); };
  }, 'collab: relay profile lifecycle');
  ctx.effect(() => ctx.connection.rpc.handle('/desktop-collab', async (endpoint, payload, signal) => {
    try { await ready; return await manager.handle(endpoint, payload, signal); }
    catch (error) { return { ok: false, error: { code: 'collab/startup', message: error instanceof Error ? error.message : '中继配置启动失败。', details: {} } }; }
  }), 'collab: user actions');
}
