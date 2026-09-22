import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { transformWithOxc } from 'vite';
import { externalWebUrl } from '../src/shared/desktop-api.ts';
import { browserBounds, validBrowserId } from '../src/shared/sidebar-browser.ts';
import { previewGrant } from '../src/main/preview-files.ts';
import { browserHistory } from '../src/main/browser-history.ts';

const source = await readFile(new URL('../src/main/sidebar-browser.ts', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*\n/gm, '').replace('export class SidebarBrowser', 'class SidebarBrowser'), 'sidebar-browser.ts', { lang: 'ts' });

test('legacy PDF previews share an isolated uncached session and revoke each closed file grant', async () => {
  const sessions = new Map<string, any>();
  const views: any[] = [];
  const session = {
    fromPartition(name: string, options: unknown) {
      if (sessions.has(name)) return sessions.get(name);
      const handlers = new Map();
      const value: any = {
        options, handlers,
        protocol: { handle: (scheme: string, handler: unknown) => { assert.ok(!handlers.has(scheme)); handlers.set(scheme, handler); } },
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest: (handler: unknown) => { value.guard = handler; } },
      };
      sessions.set(name, value);
      return value;
    },
  };
  class WebContentsView {
    webContents: any;
    options: any;
    constructor(options: any) {
      this.options = options;
      const contents: any = this.webContents = new EventEmitter();
      Object.assign(contents, {
        destroyed: false, isDestroyed: () => contents.destroyed,
        loadURL: async (url: string) => { contents.url = url; },
        close: () => { contents.destroyed = true; },
        setWindowOpenHandler() {},
        canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {},
      });
      views.push(this);
    }
    setVisible() {}
  }
  const Browser = new Function('WebContentsView', 'session', 'randomUUID', 'externalWebUrl', 'browserBounds', 'validBrowserId', 'previewGrant', 'installTextContextMenu', 'browserHistory', 'process', code + '\nreturn SidebarBrowser;')(
    WebContentsView, session, randomUUID, externalWebUrl, browserBounds, validBrowserId, previewGrant, () => {}, browserHistory, { versions: { electron: '31.7.7' } },
  );
  const window = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} } };
  const browser = new Browser(window, () => 'http://127.0.0.1:12345', () => {});
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-pdf-preview-'));
  for (const file of ['one.pdf', 'two.pdf', 'page.html']) await writeFile(join(cwd, file), file);
  const target = (file: string) => ({ kind: 'preview', cwd, sessionId: 'fixture', address: `dsh-resource://file/session/fixture/${file}` });
  await browser.open('one', target('one.pdf'), '1');
  await browser.open('two', target('two.pdf'), '1');
  const pdf = sessions.get('persist:dsh-pdf-preview');
  assert.ok(pdf);
  assert.deepEqual(pdf.options, { cache: false });
  assert.equal(views[0].options.webPreferences.session, views[1].options.webPreferences.session);
  assert.equal(views[0].options.webPreferences.sandbox, true);
  assert.equal(views[0].options.webPreferences.nodeIntegration, false);
  const read = pdf.handlers.get('dsh-preview');
  const first = views[0].webContents.url, second = views[1].webContents.url;
  const blocked = (url: string) => { let result; pdf.guard({ url }, (value: any) => { result = value.cancel; }); return result; };
  assert.equal(await (await read(new Request(first))).text(), 'one.pdf');
  assert.equal((await read(new Request(second))).headers.get('cache-control'), 'no-store');
  assert.equal(blocked(first), false);
  assert.equal(blocked(second), false);
  for (const url of ['http://localhost:12345/api/private', 'file:///etc/passwd', 'dsh://app/index.html', 'dsh-preview://unknown/one.pdf']) assert.equal(blocked(url), true);
  browser.close('one');
  assert.equal((await read(new Request(first))).status, 404);
  assert.equal(blocked(first), true);
  assert.equal(await (await read(new Request(second))).text(), 'two.pdf');
  await browser.open('html', target('page.html'), '1');
  assert.notEqual(views[2].options.webPreferences.session, pdf);
  browser.clear();
  assert.equal((await read(new Request(second))).status, 404);
  assert.ok(views.every(view => view.webContents.isDestroyed()));
});
