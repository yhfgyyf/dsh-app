import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';

const installAnchor = fileURLToPath(new URL('../.runtime/package.json', import.meta.url));
const require = createRequire(installAnchor);
const {
  boot, initProfile, loadProfileDirectory, loadOptionalPatches, readProfilePatches,
  createProfileResolutionGeneration, PluginPackages,
} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);

test('profile management persists enablement, honors existing user config and reloads live', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-profile-'));
  const profileDir = join(home, 'profiles', 'desktop');
  const bundle = join(profileDir, 'node_modules', 'desktop-profile-fixture');
  let context: any;
  try {
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'desktop-profile-fixture', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    await writeFile(join(bundle, 'probe.mjs'), 'export function apply(ctx, config) { ctx.provide("desktopProfileProbe", config.value); }\n');
    await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
    - id: hmr
      name: '@deepseek-ai/dsh-hmr'
      config: { root: [] }
    - id: plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager'
    - id: desktop-profile-probe
      name: './probe.mjs'
      config: { value: bundle-default }
`);
    const root = join(home, 'cordis.yml');
    await writeFile(root, '[]\n');
    const legacyPatch = join(home, 'desktop.patch.yml');
    await writeFile(legacyPatch, '- id: desktop-profile-probe\n  config: { value: existing-desktop-choice }\n');
    initProfile(profileDir, ['desktop-profile-fixture']);
    const start = async () => {
      const profile = loadProfileDirectory('desktop-profile-test', profileDir, installAnchor);
      const profileContext = {
        name: 'desktop', dir: profileDir, patchPath: profile.patchPath, installAnchor,
        startedBundles: profile.layers.map((layer: { packageName: string }) => layer.packageName),
        cwd: home, home, overlays: loadOptionalPatches('desktop-profile-test', legacyPatch) ?? [],
        telemetryDisabledEnv: '1',
      };
      const resolution = await createProfileResolutionGeneration({ installAnchor, profile });
      let ready = false;
      const listeners = new Set<() => void>();
      const ctx = await boot('desktop-profile-test', root, readProfilePatches('desktop-profile-test', profileContext, profile), async (host: any) => {
        host.provide('profileContext', profileContext);
        host.provide('appReady', { onReady(listener: () => void) {
          if (ready) { listener(); return () => {}; }
          listeners.add(listener); return () => { listeners.delete(listener); };
        } });
        await host.plugin(PluginPackages, { generation: resolution });
      }, pathToFileURL(installAnchor).href);
      ready = true;
      for (const listener of listeners) listener();
      return ctx;
    };
    context = await start();
    assert.equal(context.get('desktopProfileProbe'), 'existing-desktop-choice');
    const probe = (await context.pluginManager.listPlugins()).find((row: { patchId: string }) => row.patchId === 'desktop-profile-probe');
    assert.ok(probe);
    const disabled = await context.pluginManager.setPluginEnabled(probe.entryId, false);
    assert.equal(disabled.application, 'applied', JSON.stringify(disabled));
    assert.equal(context.get('desktopProfileProbe'), undefined);
    assert.match(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'), /disabled: true/);
    await context.fiber.dispose();
    context = await start();
    assert.equal(context.get('desktopProfileProbe'), undefined, 'Disable survives a fresh profile boot');
    await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: desktop-profile-probe\n  disabled: false\n');
    const deadline = Date.now() + 10000;
    while (context.get('desktopProfileProbe') === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(context.get('desktopProfileProbe'), 'existing-desktop-choice', 'HMR applies the user profile after the bundle and retains the existing desktop config');
  } finally {
    await context?.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('desktop startup loads an installed bundle by package name with shared host dependencies', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-installed-profile-'));
  const profileDir = join(home, 'profiles', 'desktop');
  const name = 'desktop-installed-bundle-fixture';
  const bundle = join(profileDir, 'node_modules', name);
  let child: ReturnType<typeof fork> | undefined;
  try {
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, 'package.json'), JSON.stringify({
      name, version: '1.0.0', type: 'module', exports: './index.mjs',
      peerDependencies: { '@deepseek-ai/cordis': '*' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }));
    await writeFile(join(bundle, 'index.mjs'), `import { Context } from '@deepseek-ai/cordis';
export const inject = ['appReady', 'deepseekLlmApiExtensions'];
export function apply(ctx) {
  if (!(ctx.root instanceof Context)) throw new Error('Installed plugin must share the host Cordis runtime');
  process.send?.({ type: 'fixture-loaded' });
  ctx.appReady.onReady(() => {
    ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: AbortSignal.timeout(5000) })
      .then(result => process.send?.({ type: 'fixture-inventory', packages: result.fields.dsh_plugin_packages.packages }))
      .catch(error => process.send?.({ type: 'fixture-inventory', error: error.message }));
  });
}
`);
    await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:\n    - id: installed-bundle-fixture\n      name: ${name}\n`);
    initProfile(profileDir, ['@deepseek-ai/dsh-base', 'dsh-desktop-surface', name]);
    const root = fileURLToPath(new URL('../.runtime/', import.meta.url));
    child = fork(fileURLToPath(new URL('../src/runtime/index.ts', import.meta.url)), [], {
      execPath: join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
      execArgv: [], cwd: home, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_CONFIG_HOME: home,
        DSH_DESKTOP_STATE_HOME: home, DSH_DESKTOP_RUNTIME_ROOT: root,
        DSH_DESKTOP_PORT: '0', DSH_TELEMETRY_DISABLED: '1' },
    });
    const core = child;
    await new Promise<void>((resolve, reject) => {
      let fixtureLoaded = false;
      let ready = false;
      let inventoried = false;
      const timer = setTimeout(() => reject(new Error('Desktop fixture did not finish startup')), 20000);
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      core.once('error', finish);
      core.once('exit', code => finish(new Error(`Desktop core exited before ready (${code})`)));
      core.on('message', (message: any) => {
        if (message.type === 'fixture-loaded') fixtureLoaded = true;
        if (message.type === 'failed') finish(new Error(message.error));
        if (message.type !== 'ready' && message.type !== 'fixture-inventory') return;
        try {
          if (message.type === 'ready') {
            assert.equal(fixtureLoaded, true, 'Installed plugin applied using the shared host dependency');
            assert.ok(message.hostPlugins.includes(name));
            assert.ok(message.hostPlugins.includes('@deepseek-ai/dsh-plugin-manager'));
            ready = true;
          } else {
            assert.equal(message.error, undefined, 'Model request preparation must resolve installed plugins');
            assert.ok(message.packages.some((pkg: any) => pkg.name === name && pkg.version === '1.0.0'));
            inventoried = true;
          }
          if (ready && inventoried) finish();
        } catch (error) { finish(error as Error); }
      });
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const core = child;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => core.kill('SIGKILL'), 5000);
        core.once('exit', () => { clearTimeout(timer); resolve(); });
        if (core.connected) core.send({ type: 'shutdown' });
        else core.kill('SIGTERM');
      });
    }
    await rm(home, { recursive: true, force: true });
  }
});
