import { createRequire } from 'node:module';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { RemoteBridge } from './remote/bridge.ts';
import { LanRemoteAccess } from './remote/lan.ts';
import { randomUUID } from 'node:crypto';
import type { LocalRemoteAction, RemoteRuntimeState } from '../shared/remote-access.ts';
import type { RemoteCredentials } from '../shared/remote-access.ts';
import { createCollabBroker } from './collab-transport.ts';
import { createBrowserUseController } from './browser-use.ts';
import { prepareLegacySettings, migrateProgressiveOverride, migrateRuntimePluginNames } from './legacy-settings.ts';

const runtimeRoot = process.env.DSH_DESKTOP_RUNTIME_ROOT;
if (!runtimeRoot || !process.env.DSH_HOME || !process.send) throw new Error('Desktop core requires an owned runtime, data directory and IPC channel.');
const require = createRequire(join(runtimeRoot, 'package.json'));
const load = (id: string) => import(pathToFileURL(require.resolve(id)).href);
const {
  boot, loadLayeredEnv, loadOptionalPatches, installFailLoud,
  initProfile, loadProfileDirectory, readProfilePatches, createRuntimeResolution, PluginPackages, reportSkippedBundles,
} = await load('@deepseek-ai/dsh-app-boot');
const directory = dirname(fileURLToPath(import.meta.url));
let context: any;
let closing = false;
let remoteBridge: RemoteBridge | undefined;
let lanRemote: LanRemoteAccess | undefined;
let remoteState: RemoteRuntimeState = { status: 'disabled' };
let collaborationCredentials: RemoteCredentials | undefined;
const localRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function localRemoteAction(action: LocalRemoteAction): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { localRequests.delete(id); reject(new Error('手机绑定超时。')); }, 30000);
    localRequests.set(id, { resolve, reject, timer });
    process.send?.({ type: 'remote-local-action', id, action });
  });
}
let ready = false;
let browserUse: Awaited<ReturnType<typeof createBrowserUseController>>;
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
  remoteBridge?.stop();
  await lanRemote?.stop();
  for (const request of localRequests.values()) { clearTimeout(request.timer); request.reject(new Error('Host closed')); }
  localRequests.clear();
  try { await context?.fiber.dispose(); } finally { process.exit(code); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close(); });
process.on('disconnect', () => { void close(); });
process.on('message', (message: unknown) => { if ((message as { type?: string })?.type === 'shutdown') void close(); });
process.on('message', (message: any) => {
  if (message?.type === 'remote-local-result' && typeof message.id === 'string') {
    const request = localRequests.get(message.id); if (!request) return;
    clearTimeout(request.timer); localRequests.delete(message.id);
    if (message.error) request.reject(new Error('手机绑定操作失败。')); else request.resolve(message.result);
    return;
  }
  if (message?.type === 'remote-configure' && typeof message.id === 'string') {
    collaborationCredentials = message.config?.credentials;
    const configure = async () => { if (!remoteBridge || !lanRemote || closing) throw new Error('远程模块未就绪。'); await lanRemote.configure(message.config); await remoteBridge.configure(message.config); };
    void configure().then(() => process.send?.({ type: 'remote-result', id: message.id }), () => process.send?.({ type: 'remote-result', id: message.id, error: '远程模块配置失败。' }));
    return;
  }
  if (message?.type === 'browser-use-configure' && typeof message.id === 'string') {
    const config = message.config;
    const configure = async () => {
      if (!browserUse || closing || typeof config?.enabled !== 'boolean' || (config.enabled && (typeof config.executablePath !== 'string' || (config.userDataDir !== undefined && (typeof config.userDataDir !== 'string' || !config.userDataDir.trim()))))) throw new Error('浏览器操作配置不可用。');
      if (config.extensionToken !== undefined && (typeof config.extensionToken !== 'string' || !/^[A-Za-z0-9_+/=-]{16,1024}$/.test(config.extensionToken) || !config.userDataDir)) throw new Error('浏览器连接令牌配置无效。');
      await browserUse.configure(config);
    };
    void configure().then(() => process.send?.({ type: 'browser-use-result', id: message.id }), error => process.send?.({ type: 'browser-use-result', id: message.id, error: error instanceof Error ? error.message : '浏览器操作配置失败。' }));
    return;
  }
  if (message?.type === 'get-boot' && typeof message.id === 'string' && context?.get('clientModules')) {
    process.send?.({ type: 'boot-result', id: message.id, graph: context.get('clientModules').graph() });
  }
});
installFailLoud('dsh-desktop', process, () => context?.fiber.dispose());
try {
  // Sessions, attachments, workspaces and credentials share the CLI's home.
  // Settings are imported once into the app's profile, as required by DSH 0.1.7.
  const launchEnvironment = loadLayeredEnv('dsh-desktop');
  const stateHome = process.env.DSH_DESKTOP_STATE_HOME ?? process.env.DSH_HOME;
  const profileDir = join(stateHome, 'profiles', 'desktop');
  const installAnchor = join(runtimeRoot, 'package.json');
  // Official 0.1.7 imports legacy settings into each profile's configuration.
  // Keep the CLI's source document available for its own independent migration.
  await prepareLegacySettings(process.env.DSH_HOME, stateHome, require('yaml'));
  const { entryListSchema } = await load('@deepseek-ai/cordis-plugin-loader');
  const patchYaml = require('js-yaml');
  await migrateProgressiveOverride(stateHome, {
    parse: (text: string) => patchYaml.load(text, { schema: entryListSchema }),
    stringify: (value: unknown) => patchYaml.dump(value, { schema: entryListSchema }),
  });
  await migrateRuntimePluginNames([join(profileDir, 'cordis.patch.yml'), join(stateHome, 'desktop.patch.yml')], {
    parse: (text: string) => patchYaml.load(text, { schema: entryListSchema }),
    stringify: (value: unknown) => patchYaml.dump(value, { schema: entryListSchema }),
  });
  initProfile(profileDir, ['@deepseek-ai/dsh-base', 'dsh-desktop-surface']);
  const localPlugins = join(profileDir, 'local-plugins');
  await mkdir(localPlugins, { recursive: true });
  // Anonymous local modules must not inherit the named profile's package metadata.
  // Exclusive creation preserves any existing user manifest, including during upgrades.
  await writeFile(join(localPlugins, 'package.json'), '{\n  "private": true\n}\n', { flag: 'wx' }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const profile = loadProfileDirectory('dsh-desktop', profileDir, installAnchor);
  reportSkippedBundles('dsh-desktop', profile);
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
  const resolution = await createRuntimeResolution({ installAnchor, profile });
  const patches = readProfilePatches('dsh-desktop', profileContext, profile);
  // Imports and package metadata must share the profile's resolution scope.
  // Bundle-relative module paths have already been anchored by readProfilePatches.
  const rootConfig = join(profileDir, '.desktop.cordis.yml');
  await copyFile(join(directory, 'cordis.yml'), rootConfig);
  context = await boot('dsh-desktop', rootConfig, patches, async (ctx: any) => {
    context = ctx;
    ctx.provide('launchEnvironment', launchEnvironment);
    ctx.provide('profileContext', profileContext);
    ctx.provide('appReady', appReady);
    ctx.provide('desktopCollabBroker', createCollabBroker(() => collaborationCredentials));
    await ctx.plugin(PluginPackages, { resolution });
  });
  const connection = context.get('connection');
  const extensionUtils = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib/tools/utils/extension.js'));
  browserUse = await createBrowserUseController(context, load, join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'), extensionUtils);
  const server = context.get('webServer');
  const modules = context.get('clientModules');
  if (!connection || !server || !modules) throw new Error('Desktop host services are incomplete.');
  // Authentication handshake only. This process has no Web App homepage or static fallback.
  context.effect(() => server.register({ kind: 'exact', path: '/', handler: (req: any, res: any) => {
    if (!connection.authorizeIndex(req, res)) return;
    res.writeHead(204); res.end();
  } }));
  const endpoint = `http://127.0.0.1:${server.port}`;
  remoteBridge = new RemoteBridge(require('ws'), endpoint, connection.authenticatedUrl(endpoint), state => {
    remoteState = { ...remoteState, ...state }; process.send?.({ type: 'remote-state', state: remoteState });
  });
  lanRemote = new LanRemoteAccess(require('ws'), endpoint, connection.authenticatedUrl(endpoint), lan => {
    remoteState = { ...remoteState, lan }; process.send?.({ type: 'remote-state', state: remoteState });
  }, localRemoteAction);
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
