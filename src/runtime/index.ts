import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const runtimeRoot = process.env.DSH_DESKTOP_RUNTIME_ROOT;
if (!runtimeRoot || !process.env.DSH_HOME || !process.send) throw new Error('Desktop core requires an owned runtime, data directory and IPC channel.');
const require = createRequire(join(runtimeRoot, 'package.json'));
const load = (id: string) => import(pathToFileURL(require.resolve(id)).href);
const {
  boot, loadLayeredEnv, loadOptionalPatches, installFailLoud,
  initProfile, loadProfileDirectory, readProfilePatches, createProfileResolutionGeneration, PluginPackages,
} = await load('@deepseek-ai/dsh-app-boot');
const directory = dirname(fileURLToPath(import.meta.url));
let context: any;
let closing = false;
let ready = false;
const readyListeners = new Set<() => void>();
const appReady = {
  onReady(listener: () => void) {
    if (ready) { listener(); return () => {}; }
    readyListeners.add(listener);
    return () => { readyListeners.delete(listener); };
  },
};
async function close(code = 0) {
  if (closing) return;
  closing = true;
  try { await context?.fiber.dispose(); } finally { process.exit(code); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close(); });
process.on('disconnect', () => { void close(); });
process.on('message', (message: unknown) => { if ((message as { type?: string })?.type === 'shutdown') void close(); });
process.on('message', (message: any) => {
  if (message?.type === 'get-boot' && typeof message.id === 'string' && context?.get('clientModules')) {
    process.send?.({ type: 'boot-result', id: message.id, graph: context.get('clientModules').graph() });
  }
});
installFailLoud('dsh-desktop', process, () => context?.fiber.dispose());
try {
  // Sessions, attachments, workspaces and model configuration share the same
  // DSH home as the CLI. Transport state and desktop overrides stay app-owned.
  const launchEnvironment = loadLayeredEnv('dsh-desktop');
  const stateHome = process.env.DSH_DESKTOP_STATE_HOME ?? process.env.DSH_HOME;
  const profileDir = join(stateHome, 'profiles', 'desktop');
  const installAnchor = join(runtimeRoot, 'package.json');
  initProfile(profileDir, ['@deepseek-ai/dsh-base', 'dsh-desktop-surface']);
  const profile = loadProfileDirectory('dsh-desktop', profileDir, installAnchor);
  const profileContext = {
    name: 'desktop', dir: profileDir, patchPath: profile.patchPath, installAnchor,
    packageManager: {
      command: join(runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
      args: ['--expose-internals', join(runtimeRoot, 'package-manager/node_modules/pnpm/bin/pnpm.mjs')],
      env: { PATH: [join(runtimeRoot, 'bin'), process.env.PATH].filter(Boolean).join(delimiter) },
    },
    startedBundles: profile.layers.map((layer: { packageName: string }) => layer.packageName),
    cwd: process.cwd(), home: stateHome,
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    overlays: [
      ...(loadOptionalPatches('dsh-desktop', join(stateHome, 'desktop.patch.yml')) ?? []),
    ],
  };
  const resolution = await createProfileResolutionGeneration({ installAnchor, profile });
  const patches = readProfilePatches('dsh-desktop', profileContext, profile);
  context = await boot('dsh-desktop', join(directory, 'cordis.yml'), patches, async (ctx: any) => {
    context = ctx;
    ctx.provide('launchEnvironment', launchEnvironment);
    ctx.provide('profileContext', profileContext);
    ctx.provide('appReady', appReady);
    await ctx.plugin(PluginPackages, { generation: resolution });
  }, pathToFileURL(join(runtimeRoot, 'package.json')).href);
  const connection = context.get('connection');
  const server = context.get('webServer');
  const modules = context.get('clientModules');
  if (!connection || !server || !modules) throw new Error('Desktop host services are incomplete.');
  // Authentication handshake only. This process has no Web App homepage or static fallback.
  context.effect(() => server.register({ kind: 'exact', path: '/', handler: (req: any, res: any) => {
    if (!connection.authorizeIndex(req, res)) return;
    res.writeHead(204); res.end();
  } }));
  const endpoint = `http://127.0.0.1:${server.port}`;
  const names = Array.from(context.loader.entries(), (entry: any) => entry.options.name);
  if (names.some((name: unknown) => typeof name === 'string' && (name.includes('dsh-web-app') || name.includes('dsh-frontend-static')))) throw new Error('Web application entrypoints are forbidden in the desktop composition.');
  ready = true;
  for (const listener of [...readyListeners]) listener();
  readyListeners.clear();
  process.send!({ type: 'ready', endpoint, launchUrl: connection.authenticatedUrl(endpoint), graph: modules.graph(), hostPlugins: names });
} catch (error) {
  console.error(error);
  process.send!({ type: 'failed', error: error instanceof Error ? error.message : 'Desktop core boot failed' });
  await close(1);
}
