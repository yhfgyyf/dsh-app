import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const upstream = fileURLToPath(new URL('../.runtime/node_modules/@deepseek-ai/', import.meta.url));
const classMap = {
  'ui-layout': ['pI_x6G_frame'],
  'ui-sidebar': ['hHd-Xa_root', 'hHd-Xa_logoRow', 'hHd-Xa_newSession', 'hHd-Xa_collapsed'],
  'ui-workspace': ['YDXeBa_sessionRow', 'YDXeBa_projectRow', 'bhn1Oq_searchButton'],
  'ui-settings-general': ['VOzbGW_trigger', 'VOzbGW_panel', 'VOzbGW_nav', 'VOzbGW_navCell'],
  'ui-chat': ['Sixlwa_bubble'],
};

test('the installed DSH version still exports every CSS-module control used by the desktop adapter', async () => {
  for (const [module, classes] of Object.entries(classMap)) {
    const source = await readFile(upstream + `dsh-client-${module}/lib/client.js`, 'utf8');
    for (const className of classes) assert.ok(source.includes(`"${className}"`), `${module}: ${className} changed; review the desktop adapter`);
  }
});

test('Host graph changes and rebuilt code preserve the page-owned desktop shell', async () => {
  const require = createRequire(new URL('../.runtime/package.json', import.meta.url));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { default: Loader } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')).href);
  const evaluate = async (packageName: string, extra: object = {}) => {
    let exports: any;
    runInNewContext(await readFile(upstream + packageName + '/lib/client.js', 'utf8'), {
      console, URL, queueMicrotask,
      document: { querySelectorAll: () => [], head: { querySelectorAll: () => [] } },
      window: { __ModuleLoader__: { load(entry: any) { exports = entry.factory((name: string) => { throw new Error('Unexpected bootstrap dependency: ' + name); }); } } },
      ...extra,
    });
    assert.ok(exports);
    return exports;
  };
  const exports = await evaluate('dsh-client-modules');
  const counts = { desktopMount: 0, desktopDispose: 0, featureMount: 0, featureDispose: 0 };
  const factories: Record<string, () => any> = {
    'desktop-shell': () => ({ apply(ctx: any) { counts.desktopMount++; ctx.effect(() => () => { counts.desktopDispose++; }); } }),
    feature: () => ({ apply(ctx: any) { counts.featureMount++; ctx.effect(() => () => { counts.featureDispose++; }); } }),
  };
  const row = (id: string, rev = 'r1') => ({ id, rev, url: `/plugins/${id}/client.js?rev=${rev}` });
  const graph = (ids: string[]) => ({ rev: ids.join(','), entries: ids.map(id => row(id)), batches: ids.length ? [{ url: '/batch', rev: ids.join(','), phase: 'application', entries: ids }] : [] });
  const target: any = { mode: 'queue', pendingQueue: [], load() {} };
  const modules = exports.createClientModuleSystem(target, { id: 'bootstrap', exports: {} }, {
    boot: graph(['desktop-shell', 'feature']), staticModules: {},
    async loadBundle(url: string) {
      const ids = url === '/batch' ? ['desktop-shell', 'feature'] : [url.split('/')[2]];
      for (const id of ids) target.load({ id, factory: factories[id] });
    },
  });
  let receive: (event: { data: string }) => void = () => {};
  let closed = false;
  const hmr = await evaluate('dsh-client-hmr', { EventSource: class {
    addEventListener(_name: string, listener: typeof receive) { receive = listener; }
    close() { closed = true; }
  } });
  const context = new Context();
  const disposers: (() => void)[] = [];
  const errors: unknown[] = [];
  try {
    await context.plugin(Loader);
    context.loader.internal = modules;
    await context.loader.create({ name: 'desktop-shell' });
    await modules.entries.start(context.loader, exports.parseBootManifest(graph(['feature'])));
    hmr.apply({ modules, effect(factory: () => () => void) { disposers.push(factory()); }, logger: { error(error: unknown) { errors.push(error); }, warn(error: unknown) { errors.push(error); } } });
    const settled = async (predicate: () => boolean) => {
      const until = Date.now() + 3000;
      while (!predicate() && !errors.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
      assert.deepEqual(errors, []);
      assert.ok(predicate(), 'HMR operation did not settle');
    };
    receive({ data: JSON.stringify({ type: 'graph', graph: graph([]) }) });
    await settled(() => counts.featureDispose === 1);
    assert.equal(counts.desktopDispose, 0);
    receive({ data: JSON.stringify({ type: 'graph', graph: graph(['feature']) }) });
    await settled(() => counts.featureMount === 2);
    receive({ data: JSON.stringify({ type: 'rebuilt', id: 'feature', rev: 'r2' }) });
    await settled(() => counts.featureMount === 3);
    assert.deepEqual(counts, { desktopMount: 1, desktopDispose: 0, featureMount: 3, featureDispose: 2 });
    assert.equal([...context.loader.entries()].filter((entry: any) => entry.options.name === 'desktop-shell').length, 1);
  } finally {
    for (const dispose of disposers) dispose();
    await context.fiber.dispose();
  }
  assert.equal(closed, true);
  assert.equal(counts.desktopDispose, 1);
});
