import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeNodeModules = process.env.DSH_OVERLAY_TEST_RUNTIME ?? fileURLToPath(new URL('../.runtime/node_modules', import.meta.url));
const source = await readFile(join(runtimeNodeModules, '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js'), 'utf8');
const storeStart = source.indexOf('//#region lib/types/client/store.js');
const storeEnd = source.indexOf('//#endregion', storeStart);
const viewStart = source.indexOf('function TextPreview(');
const viewEnd = source.indexOf('const mode = selected?.loading;', viewStart);
assert.ok(storeStart > 0 && storeEnd > storeStart && viewStart > 0 && viewEnd > viewStart);
const createStore = new Function('_deepseek_ai_dsh_client_store', source.slice(storeStart, storeEnd) + '\nreturn createTextStore;')({ defineStore: (spec: unknown) => spec });
const plain = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/text';
const html = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/html';

function harness() {
  const spec = createStore();
  const state = spec.init();
  const effects: (() => void)[] = [];
  // Execute the published component's selection and effect before loading begins.
  const preview = new Function('react', 'hostFileOf', 'matchingDocumentPreviews', 'PLAIN_BODY_ID', `${source.slice(viewStart, viewEnd)} return selected; }\nreturn TextPreview;`)(
    { useMemo: (fn: () => unknown) => fn(), useEffect: (fn: () => void) => effects.push(fn) },
    () => ({ path: '/fixture.html' }),
    (definitions: { id: string }[]) => definitions.filter(item => item.id === html),
    plain,
  );
  const actions = Object.fromEntries(Object.entries(spec.actions).map(([name, fn]) => [name, (...args: unknown[]) => (fn as Function)(state, ...args)]));
  const render = (revision: number, params: unknown = undefined, tabId = 'one') => preview({
    useTabInfo: () => ({ tab: { id: tabId, contentId: 'file:fixture.html', navigation: { revision, params } } }),
    useResource: () => ({ status: 'none' }),
    useStore: (select: Function) => select(state),
    useDocumentPreviews: () => [{ id: html, loading: 'bytes-complete' }, { id: plain, loading: 'text-pages' }],
    actions,
  }).id;
  const flush = () => { while (effects.length) effects.shift()!(); };
  return { state, actions, render, flush };
}

test('an explicit source navigation renders plain text immediately and is consumed once', () => {
  const { state, render, flush } = harness();
  assert.equal(render(1), html, 'Ordinary HTML keeps its automatic renderer');
  flush();
  assert.equal(render(2, { source: true }), plain, 'Source is plain on the initial render before effects');
  assert.equal(state.byTab.one, undefined);
  flush();
  assert.equal(state.byTab.one.rendererId, plain);
  assert.equal(state.byTab.one.sourceRevision, 2);
  assert.equal(state.byTab.one.revision, undefined, 'Source consumption is separate from line navigation');
});

test('manual viewer choices survive remount and reload; a fresh source revision requests plain again', () => {
  const { state, actions, render, flush } = harness();
  render(7, { source: true });
  flush();
  actions.selected('one', html);
  assert.equal(render(7, { source: true }), html);
  flush();
  actions.reset('one');
  assert.equal(render(7, { source: true }), html, 'Remount or reload does not repeat a consumed request');
  flush();
  assert.equal(state.byTab.one.sourceRevision, 7);
  assert.equal(render(8, { line: 3 }), html, 'A line navigation preserves the manual viewer');
  flush();
  assert.equal(render(9, { source: true }), plain);
  flush();
  assert.equal(state.byTab.one.sourceRevision, 9);
  actions.selected('one', undefined);
  assert.equal(render(9, { source: true }), html, 'Choosing automatic also preserves the consumed revision');
  flush();
  assert.equal(render(9, { source: true }, 'two'), plain, 'Source consumption is scoped to the tab');
});
