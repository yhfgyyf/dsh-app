import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
