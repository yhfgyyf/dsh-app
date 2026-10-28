import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const pnpmArgument = process.argv[2];
assert.ok(pnpmArgument, 'Usage: node scripts/test-plugin-package-management.ts <existing-pnpm-executable> [pnpm-js-entry]');
const pnpm = resolve(pnpmArgument);
const pnpmEntry = process.argv[3] === undefined ? undefined : resolve(process.argv[3]);
const runtimeRoot = resolve(process.env.DSH_TEST_DESKTOP_RUNTIME ?? join(root, '.runtime'));
const installAnchor = join(runtimeRoot, 'package.json');
const require = createRequire(installAnchor);
const { parse } = require('yaml');
await mkdir(join(root, '.test-data'), { recursive: true });
await mkdir(join(root, 'docs/evidence'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/plugin-package-management-'));
const home = join(data, 'home');
const profileDir = join(home, 'profiles', 'package-test');
const bundle = join(data, 'local-bundle');
const bundleName = 'dsh-local-package-management-fixture';
await mkdir(home);
await mkdir(bundle);
await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: bundleName, version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
await writeFile(join(bundle, 'probe.mjs'), 'export function apply(ctx) { ctx.provide("packageManagementFixture", "active"); }\n');
await writeFile(join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: package-management-fixture\n      name: ./probe.mjs\n');
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_DISABLED = '1';
const { boot, initProfile, loadProfileDirectory, readProfilePatches, createRuntimeResolution, PluginPackages } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
initProfile(profileDir, ['@deepseek-ai/dsh-base']);
await writeFile(join(profileDir, 'pnpm-workspace.yaml'), JSON.stringify({ packages: [], offline: true, ignoreScripts: true, storeDir: join(data, 'pnpm-store'), cacheDir: join(data, 'pnpm-cache'), managePackageManagerVersions: false, updateNotifier: false }));
await writeFile(join(data, 'empty-npmrc'), '');
const rootFile = join(data, 'cordis.yml');
await writeFile(rootFile, '[]\n');
const profile = loadProfileDirectory('package-management-test', profileDir, installAnchor);
const packageManager = {
  command: pnpm,
  args: [] as string[],
  env: { PATH: '/usr/bin:/bin', npm_config_userconfig: join(data, 'empty-npmrc'), pnpm_config_pm_on_fail: 'ignore' },
};
const profileContext = {
  name: 'package-test', dir: profileDir, patchPath: profile.patchPath, installAnchor,
  startedBundles: profile.layers.map((layer: any) => layer.packageName), cwd: data, home,
  overlays: [], telemetryDisabledEnv: '1', packageManager,
};
const resolution = await createRuntimeResolution({ installAnchor, profile });
let ready = false;
const readyListeners = new Set<() => void>();
let context: any;
const operations: any[] = [];
const logEvents: any[] = [];
let status = 'pass';
let failure: string | undefined;
const state = async () => {
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
  return { dependency: manifest.dependencies?.[bundleName] ?? null, enabled: manifest.dsh.profile.bundles.includes(bundleName), service: context.get('packageManagementFixture') ?? null };
};
const summarize = (result: any) => ({ application: result.application, changed: result.changed, stage: result.stage, exitCode: result.packageResult?.exitCode, errorCode: result.error?.code, output: result.packageResult?.output, diagnostic: result.error?.diagnostic });
try {
  context = await boot('package-management-test', rootFile, readProfilePatches('package-management-test', profileContext, profile), async (host: any) => {
    host.provide('profileContext', profileContext);
    host.provide('appReady', { onReady(listener: () => void) { if (ready) { listener(); return () => {}; } readyListeners.add(listener); return () => { readyListeners.delete(listener); }; } });
    await host.plugin(PluginPackages, { resolution });
  }, pathToFileURL(installAnchor).href);
  ready = true;
  for (const listener of readyListeners) listener();
  context.on('plugin-manager/install-log', (event: any) => { if (event.exitCode !== undefined) logEvents.push({ argv: event.argv, cwd: event.cwd, exitCode: event.exitCode }); });
  assert.equal(context.get('packageManagementFixture'), undefined);
  const noNode = await context.pluginManager.installBundle(`file:${bundle}`);
  operations.push({ operation: 'install-with-system-only-PATH', result: summarize(noNode), after: await state() });
  if (noNode.packageResult?.exitCode === 0 && noNode.application === 'applied') {
    const removed = await context.pluginManager.removeBundle(bundleName);
    operations.push({ operation: 'remove-after-system-only-PATH', result: summarize(removed), after: await state() });
    assert.equal(removed.application, 'applied');
  } else {
    assert.deepEqual(await state(), { dependency: null, enabled: false, service: null }, 'Failed installation must restore the profile');
  }
  packageManager.env.PATH = [join(runtimeRoot, 'bin'), '/usr/bin', '/bin'].join(delimiter);
  const version = await promisify(execFile)(pnpm, ['--version'], { cwd: data, env: { ...process.env, ...packageManager.env } });
  operations.push({ operation: 'pnpm-version', version: version.stdout.trim() });
  assert.equal(version.stdout.trim(), '11.7.0');
  const installed = await context.pluginManager.installBundle(`file:${bundle}`);
  operations.push({ operation: 'install-with-owned-node-PATH', result: summarize(installed), after: await state() });
  assert.equal(installed.packageResult?.exitCode, 0, JSON.stringify(summarize(installed)));
  const installedLayout = parse(await readFile(join(profileDir, 'node_modules/.modules.yaml'), 'utf8'));
  assert.equal(installedLayout.storeDir, join(data, 'pnpm-store/v11'), 'Package writes must use the temporary store');
  assert.equal(installed.application, 'applied', JSON.stringify(summarize(installed)));
  assert.equal((await state()).enabled, true);
  assert.equal(context.get('packageManagementFixture'), 'active');
  assert.ok((await state()).dependency);
  const removed = await context.pluginManager.removeBundle(bundleName);
  operations.push({ operation: 'remove-with-owned-node-PATH', result: summarize(removed), after: await state() });
  assert.equal(removed.packageResult?.exitCode, 0, JSON.stringify(summarize(removed)));
  assert.equal(removed.application, 'applied', JSON.stringify(summarize(removed)));
  assert.deepEqual(await state(), { dependency: null, enabled: false, service: null });
  if (pnpmEntry !== undefined) {
    packageManager.command = join(runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
    packageManager.args = ['--expose-internals', pnpmEntry];
    const directInstall = await context.pluginManager.installBundle(`file:${bundle}`);
    operations.push({ operation: 'install-with-explicit-node-and-pnpm-entry', invocation: { command: packageManager.command, args: [...packageManager.args] }, result: summarize(directInstall), after: await state() });
    assert.equal(directInstall.packageResult?.exitCode, 0, JSON.stringify(summarize(directInstall)));
    assert.equal(directInstall.application, 'applied');
    assert.equal(context.get('packageManagementFixture'), 'active');
    const directRemove = await context.pluginManager.removeBundle(bundleName);
    operations.push({ operation: 'remove-with-explicit-node-and-pnpm-entry', result: summarize(directRemove), after: await state() });
    assert.equal(directRemove.packageResult?.exitCode, 0, JSON.stringify(summarize(directRemove)));
    assert.equal(directRemove.application, 'applied');
    assert.deepEqual(await state(), { dependency: null, enabled: false, service: null });
  }
} catch (error) {
  status = 'failed'; failure = error instanceof Error ? error.message : String(error);
} finally { await context?.fiber.dispose(); }
const report = { at: new Date().toISOString(), status, failure, runtimeRoot, data, profileDir, scope: 'Full alpha2 base composition from Desktop runtime; own temporary profile and generated local bundle without dependencies or lifecycle scripts; offline pnpm operations; no model requests', packageManager, operations, logEvents };
await writeFile(join(root, 'docs/evidence/plugin-package-management-alpha2.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ status, operations: operations.map(({ operation, version, result, after }) => ({ operation, version, exitCode: result?.exitCode, application: result?.application, after })), packageCommands: logEvents.length, failure }));
if (status !== 'pass') process.exitCode = 1;
