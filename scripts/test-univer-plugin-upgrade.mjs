import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, symlink, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [archiveArg, originalArg, candidateArg] = process.argv.slice(2);
assert.ok(archiveArg && originalArg && candidateArg, 'Usage: node test-plugin-upgrade.mjs <candidate.tgz> <original-package-dir> <candidate-package-dir>');
const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = resolve(process.env.DSH_TEST_RUNTIME ?? join(root, '.runtime'));
const reportRoot = resolve(process.env.DSH_TEST_REPORTS ?? join(root, '.test-data/univer-upgrade'));
await mkdir(reportRoot, { recursive: true });
const data = await mkdtemp(join(reportRoot, 'install-fixture-'));
const home = join(data, 'home'), profileDir = join(home, 'profiles', 'test'), anchor = join(runtime, 'package.json');
const require = createRequire(anchor);
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_DISABLED = '1';
const { boot, initProfile, loadProfileDirectory, readProfilePatches, createRuntimeResolution, PluginPackages, evaluatePluginCompatibility } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
const original = JSON.parse(await readFile(join(resolve(originalArg), 'package.json'), 'utf8'));
const candidate = JSON.parse(await readFile(join(resolve(candidateArg), 'package.json'), 'utf8'));
const report = { data, runtime, original: original.version, candidate: candidate.version, checks: [], failures: [], operations: [] };
let ctx;
try {
  const refused = evaluatePluginCompatibility(original);
  assert.equal(refused.runtimeVersion, '0.2.0-rc.1');
  assert.equal(refused.exempted, false);
  assert.ok(Object.keys(refused.peers).length >= 7);
  assert.equal(evaluatePluginCompatibility(candidate), undefined);
  report.checks.push('Official runtime compatibility checker rejects unmodified upstream and accepts candidate without an exemption');
  initProfile(profileDir, ['@deepseek-ai/dsh-base']);
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
  manifest.dependencies = { ...manifest.dependencies, [original.name]: `file:${resolve(originalArg)}` };
  manifest.dsh.profile.bundles.push(original.name);
  await writeFile(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2));
  await mkdir(join(profileDir, 'node_modules'), { recursive: true });
  await symlink(resolve(originalArg), join(profileDir, 'node_modules', original.name), process.platform === 'win32' ? 'junction' : 'dir');
  const patch = '- id: univer\n  config:\n    telemetry: false\n';
  await writeFile(join(profileDir, 'cordis.patch.yml'), patch);
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), JSON.stringify({ packages: [], ignoreScripts: true, autoInstallPeers: false, strictPeerDependencies: false, storeDir: join(data, 'store'), cacheDir: join(data, 'cache'), managePackageManagerVersions: false, updateNotifier: false }));
  await writeFile(join(data, 'empty-npmrc'), '');
  const profile = loadProfileDirectory('univer-upgrade-test', profileDir, anchor);
  assert.ok(profile.skippedBundles.some(x => x.packageName === original.name));
  report.checks.push('Startup reproduces the incompatible installed bundle being skipped');
  const profileContext = { name: 'test', dir: profileDir, patchPath: profile.patchPath, installAnchor: anchor,
    startedBundles: profile.layers.map(x => x.packageName), cwd: data, home, overlays: [], telemetryDisabledEnv: '1',
    packageManager: { command: join(runtime, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), args: ['--expose-internals', join(runtime, 'package-manager/node_modules/pnpm/bin/pnpm.mjs')], env: { PATH: [join(runtime, 'bin'), process.env.PATH].join(delimiter), npm_config_userconfig: join(data, 'empty-npmrc'), DO_NOT_TRACK: '1' } },
  };
  const resolution = await createRuntimeResolution({ installAnchor: anchor, profile });
  const rootFile = join(data, 'cordis.yml'); await writeFile(rootFile, '[]\n');
  let ready = false; const listeners = new Set();
  ctx = await boot('univer-upgrade-test', rootFile, readProfilePatches('univer-upgrade-test', profileContext, profile), async host => {
    host.provide('profileContext', profileContext);
    host.provide('appReady', { onReady(listener) { if (ready) { listener(); return () => {}; } listeners.add(listener); return () => listeners.delete(listener); } });
    await host.plugin(PluginPackages, { resolution });
  }, pathToFileURL(anchor).href);
  ready = true; for (const fn of listeners) fn();
  const beforeBytes = await readFile(join(profileDir, 'package.json'));
  const denied = await ctx.pluginManager.installBundle(resolve(originalArg));
  report.operations.push({ name: 'reject-original', result: denied });
  assert.equal(denied.error?.code, 'incompatible-version');
  assert.deepEqual(await readFile(join(profileDir, 'package.json')), beforeBytes);
  report.checks.push('The official installer rejects the unsupported original without changing the profile');
  const upgraded = await ctx.pluginManager.installBundle(resolve(archiveArg));
  report.operations.push({ name: 'upgrade-candidate', result: upgraded });
  assert.equal(upgraded.packageResult?.exitCode, 0, JSON.stringify(upgraded));
  assert.equal(upgraded.application, 'restart-required', JSON.stringify(upgraded));
  assert.equal(upgraded.bundle, original.name);
  assert.equal(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'), patch);
  const installed = JSON.parse(await readFile(join(profileDir, 'node_modules', original.name, 'package.json'), 'utf8'));
  assert.equal(installed.version, candidate.version);
  assert.equal(evaluatePluginCompatibility(installed), undefined);
  const after = loadProfileDirectory('univer-upgrade-test', profileDir, anchor);
  assert.equal(after.skippedBundles.length, 0);
  assert.ok(after.layers.some(x => x.packageName === original.name));
  await assert.rejects(access(join(profileDir, 'compatibility.json')), { code: 'ENOENT' });
  report.checks.push('Tarball upgrades the existing dependency through PluginManager, preserves telemetry configuration and passes the next startup compatibility check');
} catch (error) { report.failures.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  await ctx?.fiber.dispose();
  report.status = report.failures.length ? 'fail' : 'pass';
  await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(reportRoot, 'plugin-upgrade-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, data, checks: report.checks, failures: report.failures }));
}
