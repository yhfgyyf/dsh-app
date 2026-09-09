import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

// Execute the shipped store with the actual docking engine, ignoring its CSS.
const hooks = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context);
} });
const dockkit = await import('@deepseek-ai/dsh-client-ui-dockkit');
hooks.deregister();
const source = await readFile(new URL('../.runtime/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('//#region lib/types/client/stores.js');
const end = source.indexOf('//#endregion', start);
assert.ok(start > 0 && end > start);
const createStore = new Function('_deepseek_ai_dsh_client_store', '_deepseek_ai_dsh_client_ui_dockkit', `
  const GUIDE_KIND = 'guide';
  const pageAddress = kind => 'sidebar://' + kind;
  const makeGuideTab = (id, title) => ({id, title, kind: GUIDE_KIND, contentId: pageAddress(GUIDE_KIND)});
  ${source.slice(start, end)}
  return createSidebarRightStore;
`)({ defineStore: (spec: unknown) => spec }, dockkit);

function harness() {
  const spec = createStore(() => 'Start');
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

test('closing the last document collapses with a remaining guide; undo and redo include visibility', () => {
  const { state, action, layout, open } = harness();
  const id = open();
  const before = layout();
  const entries = state.bySession.one.history.entries.length;
  action('closeTab', id);
  assert.equal(layout().expanded, false);
  assert.deepEqual(Object.values(layout().tabs).map((tab: any) => tab.kind), ['guide']);
  assert.equal(state.bySession.one.history.entries.length, entries + 1);
  action('undo');
  assert.deepEqual(layout(), before);
  action('redo');
  assert.equal(layout().expanded, false);
  open('dsh-desktop-preview');
  assert.equal(layout().expanded, true);
});

test('other files, browser tabs, and content in split or floating panes keep the sidebar open', () => {
  for (const placement of ['same', 'split', 'float']) {
    const { action, layout, open } = harness();
    const first = open();
    const second = open('dsh-desktop-browser');
    if (placement === 'split') action('dropTab', second, layout().activePaneId, 'right');
    if (placement === 'float') action('floatTab', second);
    action('closeTab', first);
    assert.equal(layout().expanded, true, placement);
    action('closeTab', second);
    assert.equal(layout().expanded, false, placement);
  }
});

test('closing the sole tab collapses after reseeding; duplicate closes and other sessions stay unchanged', () => {
  const { spec, state, action, layout, open } = harness();
  const guide = Object.keys(layout().tabs)[0];
  const id = open('dsh-desktop-preview', {replaceTab: guide});
  spec.actions.open(state, 'two');
  spec.actions.setExpanded(state, 'two', true);
  const other = state.bySession.two;
  action('closeTab', id);
  assert.equal(layout().expanded, false);
  assert.equal(Object.keys(layout().tabs).length, 1);
  assert.equal(state.bySession.two, other);
  action('setExpanded', true);
  const reopened = layout();
  action('closeTab', id);
  assert.equal(layout(), reopened);
  action('closeTab', Object.keys(layout().tabs)[0]);
  assert.equal(layout().expanded, false);
});
