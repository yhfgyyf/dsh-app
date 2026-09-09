import { WebContentsView, session } from 'electron';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { externalWebUrl } from '../shared/desktop-api.ts';
import { browserBounds, validBrowserId } from '../shared/sidebar-browser.ts';
import type { BrowserAction, BrowserState, BrowserTarget } from '../shared/sidebar-browser.ts';
import { previewGrant } from './preview-files.ts';
import { installTextContextMenu } from './context-menu.ts';

type Page = { view: WebContentsView; targetKey: string; preview?: Awaited<ReturnType<typeof previewGrant>>; state: BrowserState };

/** Native web content is isolated from the DSH renderer, preload and cookies. */
export class SidebarBrowser {
  private pages = new Map<string, Page>();
  private tickets = new Map<string, object>();
  private generation = 0;
  constructor(private window: BrowserWindow, private endpoint: () => string, private openLink: (url: string) => void) {}

  async open(id: unknown, target: BrowserTarget, navigation: string): Promise<BrowserState> {
    if (!validBrowserId(id) || !target || typeof navigation !== 'string' || navigation.length > 16384) throw new Error('浏览器参数无效。');
    return this.openPage(id, target, navigation);
  }

  private async openPage(id: string, target: BrowserTarget, navigation: string): Promise<BrowserState> {
    const key = JSON.stringify([target, navigation]);
    const previous = this.pages.get(id);
    if (previous?.targetKey === key) return { ...previous.state };
    this.close(id);
    const ticket = {};
    this.tickets.set(id, ticket);
    const generation = this.generation;
    const preview = target.kind === 'preview' ? await previewGrant(target) : undefined;
    const url = target.kind === 'web' ? externalWebUrl(target.url) : preview?.url;
    if (!url || generation !== this.generation || this.tickets.get(id) !== ticket || this.window.isDestroyed()) throw new Error('此页面无法打开。');
    const ses = session.fromPartition(preview ? 'dsh-preview-' + randomUUID() : 'persist:dsh-browser');
    if (preview) ses.protocol.handle('dsh-preview', request => preview.read(request));
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => {
      let blocked = false;
      try {
        const address = new URL(details.url), core = new URL(this.endpoint());
        const loopback = ['localhost', '127.0.0.1', '[::1]'];
        blocked = ['file:', 'dsh:'].includes(address.protocol)
          || (address.protocol === 'dsh-preview:' && address.host !== preview?.host)
          || (address.port === core.port && (address.hostname === core.hostname || (loopback.includes(address.hostname) && loopback.includes(core.hostname))));
      } catch { blocked = true; }
      callback({ cancel: blocked });
    });
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, navigateOnDragDrop: false } });
    const page: Page = { view, preview, targetKey: key, state: { id, url: preview?.path ?? url, title: '', loading: true, canGoBack: false, canGoForward: false } };
    this.pages.set(id, page);
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    const contents = view.webContents;
    installTextContextMenu(contents, this.window);
    const allowed = (value: string) => externalWebUrl(value) !== undefined || (preview !== undefined && value.startsWith('dsh-preview://' + preview.host + '/'));
    contents.on('will-navigate', (event, value) => { if (!allowed(value)) event.preventDefault(); });
    contents.on('will-redirect', (event, value) => { if (!allowed(value)) event.preventDefault(); });
    contents.setWindowOpenHandler(({ url: value }) => { const link = externalWebUrl(value); if (link) this.openLink(link); return { action: 'deny' }; });
    const publish = () => {
      if (contents.isDestroyed() || this.pages.get(id) !== page) return;
      Object.assign(page.state, { url: contents.getURL().startsWith('dsh-preview:') ? preview?.path ?? '' : contents.getURL() || url, title: contents.getTitle(), loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() });
      if (!this.window.webContents.isDestroyed()) this.window.webContents.send('desktop:browser-state', page.state);
    };
    contents.on('did-start-loading', publish);
    contents.on('did-stop-loading', publish);
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);
    contents.on('page-title-updated', publish);
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) { page.state.error = `页面加载失败（${code}），可以重试或在外部浏览器打开。`; publish(); } });
    void contents.loadURL(url).catch(() => { /* did-fail-load publishes the failure */ });
    return { ...page.state };
  }

  bounds(id: unknown, value: unknown): void {
    if (!validBrowserId(id)) throw new Error('浏览器参数无效。');
    const page = this.pages.get(id);
    if (!page) return;
    const bounds = browserBounds(value, this.window.webContents.getZoomFactor(), this.window.getContentBounds());
    if (bounds) page.view.setBounds(bounds);
    page.view.setVisible(bounds !== undefined);
  }

  navigate(id: unknown, value: unknown): void {
    const page = validBrowserId(id) ? this.pages.get(id) : undefined, url = externalWebUrl(value);
    if (!page || !url) throw new Error('请输入有效的网址。');
    page.state.error = undefined;
    void page.view.webContents.loadURL(url).catch(() => {});
  }

  action(id: unknown, action: BrowserAction): void {
    const page = validBrowserId(id) ? this.pages.get(id) : undefined;
    if (!page) return;
    const contents = page.view.webContents;
    page.state.error = undefined;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
    else if (!['back', 'forward', 'reload', 'stop'].includes(action)) throw new Error('浏览器操作无效。');
  }

  close(id: string): void {
    this.tickets.delete(id);
    const page = this.pages.get(id);
    if (!page) return;
    this.pages.delete(id);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false });
  }

  clear(): void { this.generation++; this.tickets.clear(); for (const id of this.pages.keys()) this.close(id); }
}
