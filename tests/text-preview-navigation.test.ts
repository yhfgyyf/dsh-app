import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';
import { decodePreviewText, TEXT_ENCODINGS } from '../src/shared/document-preview.ts';

const source = await readFile(new URL('../src/renderer/document-preview.tsx', import.meta.url), 'utf8');
const start = source.indexOf('export interface DocumentProps');
const end = source.indexOf('function MediaDocument(');
assert.ok(start >= 0 && end > start);
// Run the real TSX component with deterministic hooks and layout, without Electron.
const { code } = await transformWithOxc(source.slice(start, end).replace('export interface DocumentProps', 'interface DocumentProps'), 'text-preview.tsx', {
  lang: 'tsx', jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'Fragment', development: false },
});
const component = new Function('useEffect', 'useMemo', 'useRef', 'useState', 'decodePreviewText', 'TEXT_ENCODINGS', 'h', 'Fragment', 'requestAnimationFrame', 'cancelAnimationFrame', code + '\nreturn TextDocument;');
type Tree = { type: unknown; props: Record<string, any> };
const children = (tree: Tree): unknown[] => [tree.props.children].flat(Infinity);
function find(tree: Tree, predicate: (tree: Tree) => boolean): Tree | undefined {
  if (predicate(tree)) return tree;
  for (const child of children(tree)) if (child && typeof child === 'object' && 'props' in child) {
    const found = find(child as Tree, predicate);
    if (found) return found;
  }
}
function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value && typeof value === 'object' && 'props' in value) return textOf((value as Tree).props.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function harness(text: string, line: unknown = 3) {
  const controller = new AbortController();
  const tab = { visible: true, signal: controller.signal, navigation: { revision: 1, params: { line } } };
  let hooks: any[] = [], cursor = 0, effects: (() => void)[] = [], nextFrame = 0, writes = 0, scroll = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const host = { get scrollTop() { return scroll; }, set scrollTop(value: number) { scroll = value; writes++; }, getBoundingClientRect: () => ({ top: 50 }) };
  const view = component(
    (effect: () => (() => void) | undefined, deps: unknown[]) => {
      const index = cursor++, previous = hooks[index];
      if (same(previous?.deps, deps)) return;
      const slot = hooks[index] = { kind: 'effect', deps, cleanup: undefined as (() => void) | undefined };
      effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
    },
    (factory: () => unknown, deps: unknown[]) => {
      const index = cursor++;
      if (!same(hooks[index]?.deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    (initial: unknown) => hooks[cursor++] ??= { current: initial },
    (initial: unknown) => {
      const index = cursor++;
      hooks[index] ??= { value: initial };
      return [hooks[index].value, (value: unknown) => { hooks[index].value = value; }];
    },
    decodePreviewText, TEXT_ENCODINGS,
    (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    Symbol('fragment'),
    (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    (id: number) => frames.delete(id),
  );
  let props = { resourceAddress: 'dsh-resource://file/session/s1/notes.txt', content: { kind: 'bytes', data: new TextEncoder().encode(text) }, wrap: false, useTabInfo: () => ({ tab }) };
  let tree: Tree;
  const render = () => {
    cursor = 0;
    tree = view(props);
    const target = find(tree, element => element.props.ref !== undefined);
    if (target) target.props.ref.current = {
      closest: (selector: string) => selector === '[data-textpreview-body]' ? host : null,
      getBoundingClientRect: () => ({ top: 50 + 48 + (Number(target.props['data-textpreview-line']) - 1) * 20 - scroll }),
    };
    for (const effect of effects.splice(0)) effect();
    return tree;
  };
  return {
    tab, controller, host, render,
    frame() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); } },
    get writes() { return writes; },
    setText(text: string) { props = { ...props, content: { kind: 'bytes', data: new TextEncoder().encode(text) } }; return render(); },
    setWrap(wrap: boolean) { props = { ...props, wrap }; return render(); },
    encoding(value: string) { find(tree, element => element.type === 'select')!.props.onChange({ target: { value } }); return render(); },
    remount() { for (const hook of hooks) hook?.cleanup?.(); hooks = []; effects = []; return render(); },
  };
}

test('TXT navigation reveals the requested line after the owner restores its scroll position', () => {
  const content = '第一行\r\n第二行\r\n目标行\r\n最后一行';
  const state = harness(content);
  const tree = state.render();
  const target = find(tree, node => node.props['data-textpreview-target'] === 3);
  assert.equal(textOf(target), '目标行\r\n');
  assert.equal(textOf(find(tree, node => node.type === 'pre')), content);
  state.host.scrollTop = 17; // The owner restores its stored position in a passive effect.
  state.frame();
  assert.equal(state.host.scrollTop, 88);
});

test('only a fresh TXT navigation revision moves scrolling; wrap, encoding, content reload and remount do not', () => {
  const state = harness('one\ntwo\nthree\nfour');
  state.render(); state.frame();
  state.host.scrollTop = 23;
  const before = state.writes;
  state.setWrap(true); state.frame();
  state.encoding('utf-8'); state.frame();
  state.setText('changed\ntwo\nthree\nfour'); state.frame();
  state.remount(); state.frame();
  assert.equal(state.host.scrollTop, 23);
  assert.equal(state.writes, before);
  state.tab.navigation = { revision: 2, params: { line: 4 } };
  state.render(); state.frame();
  assert.equal(state.host.scrollTop, 108);
  assert.equal(state.writes, before + 1);
});

test('TXT navigation waits for visibility, cancels closed tabs and consumes out-of-range requests', () => {
  const hidden = harness('one\ntwo\nthree');
  hidden.tab.visible = false;
  hidden.render(); hidden.frame();
  assert.equal(hidden.writes, 0);
  hidden.tab.visible = true;
  hidden.render(); hidden.frame();
  assert.equal(hidden.host.scrollTop, 88);
  const closed = harness('one\ntwo\nthree');
  closed.render(); closed.controller.abort(); closed.frame();
  assert.equal(closed.writes, 0);
  const missing = harness('one\ntwo', 5);
  missing.render(); missing.frame();
  missing.setText('one\ntwo\nthree\nfour\nfive'); missing.frame();
  assert.equal(missing.writes, 0, 'A content reload must not replay a handled revision');
});

test('targeting a line in a million-line TXT preserves all text with a bounded number of elements', () => {
  const content = 'line\n'.repeat(1_000_000);
  const state = harness(content, 900_000);
  const tree = state.render();
  const pre = find(tree, node => node.type === 'pre')!;
  assert.equal(textOf(pre), content);
  const elements: Tree[] = [];
  find(pre, node => { elements.push(node); return false; });
  assert.ok(elements.length <= 4, `Expected bounded DOM, found ${elements.length} elements`);
  assert.equal(textOf(find(pre, node => node.props['data-textpreview-target'] === 900_000)), 'line\n');
});
