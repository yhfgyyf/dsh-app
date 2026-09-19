import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';
import { externalWebUrl } from '../src/shared/desktop-api.ts';
import { BROWSER_TAB_ID, PREVIEW_TAB_ID, browserTitle, webAddress, webUrlOf } from '../src/shared/sidebar-browser.ts';

const source = await readFile(new URL('../src/renderer/sidebar-browser.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function BrowserTab(');
const end = source.indexOf('export function installSidebarBrowser(');
assert.ok(start >= 0 && end > start);
const { code } = await transformWithOxc(source.slice(start).replace('export function installSidebarBrowser', 'function installSidebarBrowser'), 'browser-tab.tsx', {
  lang: 'tsx', jsx: { runtime: 'classic', pragma: 'h', development: false },
});
type Tree = { type: unknown; props: Record<string, any> };
const { BrowserTab, installSidebarBrowser } = new Function('useEffect', 'useMemo', 'useRef', 'useState', 'externalWebUrl', 'webAddress', 'webUrlOf', 'h', 'BROWSER_TAB_ID', 'PREVIEW_TAB_ID', 'browserTitle', 'window', code + '\nreturn { BrowserTab, installSidebarBrowser };')(
  () => {}, (factory: () => unknown) => factory(), () => ({ current: null }), () => [undefined, () => {}],
  externalWebUrl, webAddress, webUrlOf,
  (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: { ...props, children } }),
  BROWSER_TAB_ID, PREVIEW_TAB_ID, browserTitle, {},
);

function sourceButton(tree: Tree): Tree | undefined {
  if (tree.type === 'button' && tree.props.children.includes('源码')) return tree;
  for (const child of tree.props.children.flat(Infinity)) {
    if (child && typeof child === 'object' && 'props' in child) {
      const found = sourceButton(child);
      if (found) return found;
    }
  }
}

test('source navigation keeps the preview tab owner when another session is active', () => {
  const opened: unknown[] = [];
  const address = 'dsh-resource://file/session/child/report.html';
  let injected: object = {};
  installSidebarBrowser({
    effect: (factory: () => unknown) => factory(),
    sidebarRight: {
      openResource() { throw new Error('Navigation escaped to the selected parent session'); },
      openResourceIn: (...args: unknown[]) => opened.push(args),
    },
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject: (_name: string, factory: () => unknown) => factory(),
      register(options: { key: string; inject(): object }) {
        if (options.key === PREVIEW_TAB_ID) injected = options.inject();
        return () => {};
      },
    },
  });
  const tree = BrowserTab({
    ...injected,
    sessionId: 'child',
    useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { child: { cwd: '/child' } } }),
    useTabInfo: () => ({ panel: { id: 'child-pane' }, tab: {
      id: 'tab-1', kind: 'preview', contentId: address, visible: true,
      signal: new AbortController().signal, navigation: { revision: 1 },
      actions: { openResource() { throw new Error('Tab actions discard the renderer kind override'); } },
    } }),
  });
  const button = sourceButton(tree);
  assert.ok(button);
  button.props.onClick();
  assert.deepEqual(opened, [['child', address, { kind: 'text', paneId: 'child-pane', params: { source: true } }]]);
});
