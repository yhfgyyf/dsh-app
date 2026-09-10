import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Execute the shipped store and pure docking engine without loading React UI dependencies.
const runtimeNodeModules = process.env.DSH_OVERLAY_TEST_RUNTIME ?? fileURLToPath(new URL('../.runtime/node_modules', import.meta.url));
const source = await readFile(join(runtimeNodeModules, '@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js'), 'utf8');
const start = source.indexOf('//#region lib/types/client/stores.js');
const end = source.indexOf('//#endregion', start);
assert.ok(start > 0 && end > start);
const storeSource = source.slice(start, end);
const dockkitSource = await readFile(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-client-ui-dockkit')), 'utf8');
const engineStart = dockkitSource.indexOf('//#region lib/types/engine/tree.js');
const engineEnd = dockkitSource.indexOf('//#region lib/types/components/measure.js', engineStart);
assert.ok(engineStart > 0 && engineEnd > engineStart);
const engineNames = [...new Set([...storeSource.matchAll(/_deepseek_ai_dsh_client_ui_dockkit\.([A-Za-z_][A-Za-z_0-9]*)/g)].map(match => match[1]))];
assert.ok(engineNames.length > 0);
const dockkit = new Function(`${dockkitSource.slice(engineStart, engineEnd)}\nreturn { ${engineNames.join(', ')} };`)();
const createStore = new Function('_deepseek_ai_dsh_client_store', '_deepseek_ai_dsh_client_ui_dockkit', `
  const pageAddress = kind => 'sidebar://' + kind;
  ${storeSource}
  return createSidebarRightStore;
`)({ defineStore: (spec: unknown) => spec }, dockkit);

function harness() {
  const spec = createStore(() => ({ kind: 'guide', title: 'Start' }));
  const state = spec.init();
  const action = (name: string, ...args: unknown[]) => spec.actions[name](state, 'one', ...args);
  const layout = () => state.bySession.one.layout;
  const open = (kind = 'text', options = {}) => {
    let id = '';
    action('openContent', {kind, contentId: 'file:' + Math.random(), title: 'File', ...options}, (value: string) => { id = value; });
    return id;
  };
  action('open');
  return { spec, state, action, layout, open };
}

test('rc.1 starts empty and closes its last docked document; undo and redo include visibility', () => {
  const { state, action, layout, open } = harness();
  assert.equal(layout().expanded, false);
  assert.equal(Object.keys(layout().tabs).length, 0);
  const id = open();
  const before = layout();
  const entries = state.bySession.one.history.entries.length;
  action('closeTab', id);
  assert.equal(layout().expanded, false);
  assert.equal(Object.keys(layout().tabs).length, 0, 'Collapsed rc.1 surfaces do not reseed');
  assert.equal(layout().mode, 'push');
  assert.equal(state.bySession.one.history.entries.length, entries + 1);
  action('undo');
  assert.deepEqual(layout(), before);
  action('redo');
  assert.equal(layout().expanded, false);
  open('dsh-desktop-preview');
  assert.equal(layout().expanded, true);
});

test('other docked files and browser tabs keep the sidebar open', () => {
  for (const placement of ['same', 'split']) {
    const { action, layout, open } = harness();
    const first = open();
    const second = open('dsh-desktop-browser');
    if (placement === 'split') action('dropTab', second, layout().activePaneId, 'right');
    action('closeTab', first);
    assert.equal(layout().expanded, true, placement);
    action('closeTab', second);
    assert.equal(layout().expanded, false, placement);
  }
});

test('floating content survives collapse of the final docked document', () => {
  const { action, layout, open } = harness();
  const first = open();
  const floating = open('dsh-desktop-browser');
  action('floatTab', floating);
  action('closeTab', first);
  assert.equal(layout().expanded, false);
  assert.ok(layout().tabs[floating], 'A floating pane renders independently of the column');
  action('closeTab', floating);
  assert.equal(Object.keys(layout().tabs).length, 0);
});

test('rc.1 preserves an explicit guide and protects it when it is the sole docked tab', () => {
  const { action, layout, open } = harness();
  action('setExpanded', true);
  const guide = Object.keys(layout().tabs)[0];
  assert.equal(layout().tabs[guide].kind, 'guide');
  action('closeTab', guide);
  assert.ok(layout().tabs[guide]);
  const file = open();
  action('closeTab', file);
  assert.equal(layout().expanded, true, 'Do not reapply the retired alpha guide-closing policy');
  assert.deepEqual(Object.keys(layout().tabs), [guide]);
});

test('replacing a guide then closing collapses without reseeding; duplicate closes and other sessions stay unchanged', () => {
  const { spec, state, action, layout, open } = harness();
  action('setExpanded', true);
  const guide = Object.keys(layout().tabs)[0];
  const id = open('dsh-desktop-preview', {replaceTab: guide});
  spec.actions.open(state, 'two');
  spec.actions.setExpanded(state, 'two', true);
  const other = state.bySession.two;
  action('closeTab', id);
  assert.equal(layout().expanded, false);
  assert.equal(Object.keys(layout().tabs).length, 0);
  assert.equal(state.bySession.two, other);
  action('setExpanded', true);
  const reopened = layout();
  action('closeTab', id);
  assert.equal(layout(), reopened);
  action('closeTab', Object.keys(layout().tabs)[0]);
  assert.equal(layout().expanded, true, 'The sole reseeded guide cannot be closed in rc.1');
});

test('rc.1 sidebar installer verifies the upstream implementation without rewriting it', async () => {
  const { applySidebarAutoclose } = await import(new URL('../scripts/install-sidebar-autoclose.mjs', import.meta.url).href);
  assert.deepEqual(await applySidebarAutoclose({ runtimeNodeModules, mode: 'check' }), { pending: 0 });
  assert.deepEqual(await applySidebarAutoclose({ runtimeNodeModules, mode: 'verify' }), { changed: 0, verified: true, upstream: true });
});
