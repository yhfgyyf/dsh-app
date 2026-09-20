import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import * as stores from '@deepseek-ai/dsh-client-store';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageName = '@deepseek-ai/dsh-client-ui-plugin-manager';
const relativeClient = `${packageName}/lib/client.js`;
const source = await readFile(join(root, '.runtime/node_modules', relativeClient), 'utf8');

test('Settings marketplace and sidebar share the official controller with only one install dialog owner', async () => {
  const element = (type: any, props: any) => ({ type, props });
  const dependencies: Record<string, unknown> = {
    react: { useState: (value: unknown) => [value, () => {}], useEffect() {}, useId: () => 'fixture-id' },
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
    '@deepseek-ai/dsh-client-ui-primitives': {},
    '@deepseek-ai/dsh-client-ui-slots': { resolveSlotLabel: (label: any) => typeof label === 'function' ? label() : label },
    '@deepseek-ai/dsh-client-store': stores,
  };
  let plugin: any;
  runInNewContext(source, { AbortController, console, window: { __ModuleLoader__: { load(entry: any) { plugin = entry.factory((name: string) => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }); } } } });
  const registrations: any[] = [];
  const factories = new Map<string, any>();
  const disposers: (() => void)[] = [];
  const inspected: string[] = [];
  const context = {
    effect(factory: () => () => void) { disposers.push(factory()); },
    on() { return () => {}; },
    locale: { register() { return () => {}; }, bind() { return (key: string) => key; }, getSnapshot() { return { revision: 1 }; } },
    remote: { $on() { return () => {}; }, pluginManager: { async inspect(spec: string) {
      inspected.push(spec);
      return { ok: true, value: { status: 'refused', problem: 'not-bundle', reason: 'fixture refuses installation' } };
    } } },
    slots: { inject(_name: string, factory: () => unknown) { factory(); }, register(options: any, component: any) { registrations.push({ options, component }); return () => {}; }, registerFactory(options: any, component: any) { factories.set(options.name, { options, component }); return () => {}; }, getVersion() { return 1; }, entries() { return []; } },
  };
  plugin.apply(context);
  try {
    const main = registrations.find(entry => entry.options.name === 'main');
    const market = registrations.find(entry => entry.options.name === 'settings.section');
    assert.equal(market.options.id, 'desktop-plugin-marketplace');
    assert.equal(market.options.label(), 'marketplaceTitle');
    assert.ok(market.options.children['plugins.marketplace']);
    assert.equal(main.options.children['plugins.marketplace'], undefined, 'Discovery is exclusive to Settings');
    const mainFace = main.options.inject(), marketFace = market.options.inject();
    assert.equal(mainFace.hooks.pluginManager, marketFace.hooks.pluginManager);
    const render = (registration: any, face: any) => {
      const slots: any[] = [];
      const tree = registration.component({ ...face, t: (key: string) => key,
        usePluginManager: (select: any) => select(face.hooks.pluginManager.getSnapshot()),
        useConfigLedger: (select: any) => select(face.hooks.configLedger.getSnapshot()),
        renderSlot: (name: string, props: any) => { slots.push({ name, props }); return null; },
        renderFactorySlot: (name: string, props: any) => element(factories.get(name).component, props),
      });
      const dialog = tree.props.children.find((node: any) => node?.type?.name === 'InstallDialog');
      return { slots, dialog: dialog.props.install, dialogProps: dialog.props };
    };
    assert.equal(render(main, mainFace).slots.length, 0);
    assert.ok(factories.get('plugins.install.dialog').options.children['plugins.install.review']);
    const discovery = render(market, marketFace).slots.find(entry => entry.name === 'plugins.marketplace');
    discovery.props.onInstall('dsh-marketplace-test@1.2.3');
    assert.equal(render(market, marketFace).dialog.spec, 'dsh-marketplace-test@1.2.3');
    assert.equal(render(market, marketFace).dialog.open, true);
    assert.equal(render(main, mainFace).dialog.open, false, 'Underlying sidebar must not open a second modal');
    const dialogProps = render(market, marketFace).dialogProps;
    const modal = factories.get('plugins.install.dialog').component({ ...dialogProps, t: (key: string) => key });
    const [reviewButton, directButton] = modal.props.footer.props.children;
    assert.equal(reviewButton.props.children, 'installReviewFirst');
    assert.equal(reviewButton.props.onClick, marketFace.reviewBeforeInstall);
    assert.equal(directButton.props.children.at(-1), 'installDirect');
    assert.equal(directButton.props.onClick, marketFace.runInstall);
    assert.equal(reviewButton.props.disabled, false);
    assert.equal(directButton.props.disabled, false);
    marketFace.runInstall();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(inspected, ['dsh-marketplace-test@1.2.3']);
    assert.equal(render(market, marketFace).dialog.inputError.reason, 'fixture refuses installation');
    marketFace.closeInstall();
    mainFace.openInstall();
    assert.equal(render(main, mainFace).dialog.open, true);
    assert.equal(render(market, marketFace).dialog.open, false);
  } finally { for (const dispose of disposers.reverse()) dispose(); }
});

test('marketplace adapter is pinned, idempotent, backs up the original and refuses unknown edits', async () => {
  const { applyPluginMarketplace } = await import(new URL('../scripts/install-plugin-marketplace.mjs', import.meta.url).href);
  assert.deepEqual(await applyPluginMarketplace({ mode: 'verify' }), { changed: 0, verified: true });
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-marketplace-adapter-')));
  try {
    const runtimeNodeModules = join(scratch, 'node_modules');
    const target = join(runtimeNodeModules, relativeClient);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(join(runtimeNodeModules, packageName, 'package.json'), JSON.stringify({ name: packageName, version: '0.1.6-alpha.2' }));
    await writeFile(target, source);
    const patch = join(root, 'patches/dsh-0.1.6-alpha.2/plugin-marketplace/client.patch');
    const reversed = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--reverse', '--unsafe-paths', '--directory=' + runtimeNodeModules.replaceAll('\\', '/'), patch], { cwd: scratch, encoding: 'utf8' });
    assert.equal(reversed.status, 0, reversed.stderr);
    const before = await readFile(target, 'utf8');
    const options = { runtimeNodeModules, backupHome: join(scratch, 'backup') };
    assert.deepEqual(await applyPluginMarketplace({ ...options, mode: 'check' }), { pending: 1 });
    const applied = await applyPluginMarketplace(options);
    assert.equal(applied.changed, 1);
    assert.equal(await readFile(join(applied.backup, relativeClient), 'utf8'), before);
    assert.deepEqual(await applyPluginMarketplace(options), { changed: 0, verified: true });
    assert.equal(await readFile(target, 'utf8'), source);
    const previous = join(root, 'patches/dsh-0.1.6-alpha.2/plugin-marketplace/upgrade-0.1.16.patch');
    const requiredReview = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--reverse', '--unsafe-paths', '--directory=' + runtimeNodeModules.replaceAll('\\', '/'), previous], { cwd: scratch, encoding: 'utf8' });
    assert.equal(requiredReview.status, 0, requiredReview.stderr);
    assert.equal((await applyPluginMarketplace(options)).changed, 1);
    assert.equal(await readFile(target, 'utf8'), source);
    // An already-installed 0.1.14 adapter has its own exact migration path.
    const upgradePatch = join(root, 'patches/dsh-0.1.6-alpha.2/plugin-marketplace/upgrade-0.1.14.patch');
    const oldVersion = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--reverse', '--unsafe-paths', '--directory=' + runtimeNodeModules.replaceAll('\\', '/'), upgradePatch], { cwd: scratch, encoding: 'utf8' });
    assert.equal(oldVersion.status, 0, oldVersion.stderr);
    assert.deepEqual(await applyPluginMarketplace({ ...options, mode: 'check' }), { pending: 1 });
    assert.equal((await applyPluginMarketplace(options)).changed, 1);
    assert.equal(await readFile(target, 'utf8'), source);
    const unknown = source + '\n// local change\n';
    await writeFile(target, unknown);
    await assert.rejects(applyPluginMarketplace(options), /Unrecognized changes preserved/);
    assert.equal(await readFile(target, 'utf8'), unknown);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
