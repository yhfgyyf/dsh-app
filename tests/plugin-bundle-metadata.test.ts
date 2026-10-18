import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as metadata from '../src/runtime/plugin-bundle-metadata.ts';

const runtimeRoot = fileURLToPath(new URL('../.runtime/', import.meta.url));
const require = createRequire(join(runtimeRoot, 'package.json'));
const { Peer } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-connection')).href);
const { boot, initProfile, loadProfileDirectory, readProfilePatches, createRuntimeResolution, PluginPackages } =
  await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);

test('detail metadata follows the resolved profile package through the real manager and RPC gateway', { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bundle-metadata-'));
  const installDir = join(home, 'installation');
  const installAnchor = join(installDir, 'package.json');
  const profileDir = join(home, 'profile');
  const bundleName = 'desktop-metadata-fixture';
  let ctx: any;
  try {
    await mkdir(join(installDir, 'node_modules'), { recursive: true });
    for (const entry of await readdir(join(runtimeRoot, 'node_modules'), { withFileTypes: true })) {
      if (entry.isFile()) continue;
      await symlink(join(runtimeRoot, 'node_modules', entry.name), join(installDir, 'node_modules', entry.name), 'junction');
    }
    const installation = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'));
    await writeFile(installAnchor, JSON.stringify({ ...installation, dependencies: { ...installation.dependencies, [bundleName]: '0.1.3' } }));
    for (const [root, version] of [[installDir, '0.1.3'], [profileDir, '0.2.0']]) {
      const dir = join(root, 'node_modules', bundleName);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: bundleName, version,
        description: `Description ${version}`, type: 'module', main: 'index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
      await writeFile(join(dir, 'index.mjs'), `export function apply(ctx) { ctx.provide('metadataProbe', '${version}'); }\n`);
      await writeFile(join(dir, 'cordis.patch.yml'), `- insert:
    - id: plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager'
    - id: typert
      name: '@deepseek-ai/dsh-typert-registry'
    - id: api-gateway
      name: '@deepseek-ai/dsh-api-gateway'
    - id: remote-access
      name: '@deepseek-ai/dsh-api-remote-access'
    - id: metadata-probe
      name: ${bundleName}
`);
    }
    initProfile(profileDir, [bundleName]);
    const profileManifest = join(profileDir, 'package.json');
    await writeFile(profileManifest, JSON.stringify({ ...JSON.parse(await readFile(profileManifest, 'utf8')),
      dependencies: { [bundleName]: '0.2.0' } }));
    const profile = loadProfileDirectory('metadata-test', profileDir, installAnchor);
    const profileContext = { name: 'desktop', dir: profileDir, patchPath: profile.patchPath, installAnchor,
      startedBundles: profile.layers.map((layer: any) => layer.packageName), cwd: home, home, overlays: [] };
    const resolution = await createRuntimeResolution({ installAnchor, profile });
    const rootConfig = join(profileDir, 'cordis.yml');
    await writeFile(rootConfig, '[]\n');
    ctx = await boot('metadata-test', rootConfig, readProfilePatches('metadata-test', profileContext, profile), async (host: any) => {
      host.provide('profileContext', profileContext);
      await host.plugin(PluginPackages, { resolution });
    });
    assert.equal(ctx.metadataProbe, '0.2.0', 'The profile actually runs the new code');
    const peer = new Peer(ctx, { principal: { kind: 'owner' } });
    const list = () => ctx.typertGateway.invoke({ namespace: 'pluginManager', method: 'listBundles', args: {}, peer });
    const before = await list();
    const originalList = ctx.pluginManager.listBundles;
    const old = before.find((row: any) => row.name === bundleName);
    assert.equal(old.version, '0.1.3', 'Reproduce the stale installed-bundle version');
    assert.equal(old.readOnlyReason, 'management-required');
    const fix = ctx.plugin(metadata);
    await fix.await();
    const after = await list();
    const current = after.find((row: any) => row.name === bundleName);
    assert.deepEqual(current, { ...old, version: '0.2.0', description: 'Description 0.2.0',
      meta: { title: bundleName, description: 'Description 0.2.0' } }, 'Only display metadata changes');
    assert.deepEqual(after.filter((row: any) => row.name !== bundleName), before.filter((row: any) => row.name !== bundleName));
    const manifestPath = join(profileDir, 'node_modules', bundleName, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '0.2.1', description: '' }));
    const updated = (await list()).find((row: any) => row.name === bundleName);
    assert.equal(updated.version, '0.2.1', 'A repeated refresh does not reuse the package lookup cache');
    assert.equal(updated.description, undefined);
    await writeFile(manifestPath, '{');
    assert.deepEqual(await list(), await originalList.call(ctx.pluginManager), 'An unreadable install retains the original diagnostics');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await fix.dispose();
    assert.deepEqual(await list(), before, 'Disposal restores the original method and RPC binding');
  } finally {
    await ctx?.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
