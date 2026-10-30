import { BrowserWindow, ipcMain, nativeTheme, screen } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readContentFindAction, readContentFindId, readContentFindState } from '../shared/content-find.ts';
import type { ContentFindAction, ContentFindState } from '../shared/content-find.ts';

/** A modeless search surface above the app and its native views, outside page layout. */
export class ContentFindWindow {
  private window?: BrowserWindow;
  private loading?: Promise<void>;
  private state?: ContentFindState;
  private disposed = false;
  private reposition = () => {
    if (!this.window || this.parent.isDestroyed()) return;
    const bounds = this.parent.getContentBounds(), area = screen.getDisplayMatching(bounds).workArea;
    const size = this.window.getBounds();
    const x = Math.max(area.x, Math.min(bounds.x + bounds.width - size.width - 12, area.x + area.width - size.width));
    const y = Math.max(area.y, Math.min(bounds.y + 80, area.y + area.height - size.height));
    this.window.setPosition(Math.round(x), Math.round(y));
  };
  private hide = () => this.dismiss(false);

  constructor(private parent: BrowserWindow, private root: string, private searchSessions: () => void) {
    const check = (event: IpcMainInvokeEvent) => {
      const window = this.window;
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || event.senderFrame.url !== pathToFileURL(join(root, 'dist/renderer/content-find/index.html')).href) throw new Error('此页面不能访问内容搜索窗口。');
    };
    ipcMain.handle('content-find:state', event => { check(event); return this.state; });
    ipcMain.handle('content-find:action', (event, value) => {
      check(event);
      const action = readContentFindAction(value);
      if (action.id !== this.state?.id) return;
      if (action.type === 'close') this.dismiss(true);
      else {
        if (action.type === 'query') this.state = { ...this.state, query: action.query, matches: 0, active: 0, limited: false, error: '' };
        this.send(action);
      }
    });
    parent.on('move', this.reposition);
    parent.on('resize', this.reposition);
    parent.on('hide', this.hide);
    parent.on('minimize', this.hide);
    parent.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.dismiss(false); });
    parent.once('closed', () => this.dispose());
  }

  private send(action: ContentFindAction) {
    if (!this.parent.isDestroyed() && !this.parent.webContents.isDestroyed()) this.parent.webContents.send('desktop:content-find-action', action);
  }

  private dismiss(focus: boolean) {
    const id = this.state?.id;
    this.state = undefined;
    this.window?.hide();
    if (id) this.send({ id, type: 'close' });
    if (focus && !this.parent.isDestroyed()) { this.parent.focus(); this.parent.webContents.focus(); }
  }

  async show(value: unknown) {
    const id = readContentFindId(value);
    if (this.disposed || this.parent.isDestroyed()) return;
    if (this.state?.id !== id) this.state = { id, query: '', matches: 0, active: 0, limited: false, error: '' };
    if (!this.window) {
      const window = new BrowserWindow({
        parent: this.parent, modal: false, title: 'DSH 内容搜索', width: 344, height: 44,
        show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? '#242424' : '#f6f6f6',
        webPreferences: { preload: join(this.root, 'dist/content-find-preload/index.cjs'), partition: 'content-find', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
      });
      this.window = window;
      window.setMenu(null);
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const key = input.key.toLowerCase();
        if (key === 'escape') { event.preventDefault(); this.dismiss(true); }
        else if ((input.meta || input.control) && !input.alt && !input.shift) {
          if (key === 's') { event.preventDefault(); window.webContents.send('content-find:focus'); }
          else if (key === 'f') { event.preventDefault(); this.dismiss(true); this.searchSessions(); }
        }
      });
      window.on('close', event => { event.preventDefault(); this.dismiss(true); });
      window.on('closed', () => { if (this.window === window) this.window = undefined; });
      this.loading = window.loadFile(join(this.root, 'dist/renderer/content-find/index.html'));
    }
    await this.loading;
    if (this.state?.id !== id || this.disposed || !this.window || this.window.isDestroyed()) return;
    this.reposition();
    this.window.webContents.send('content-find:state', this.state);
    this.window.show(); this.window.focus();
    this.window.webContents.send('content-find:focus');
  }

  update(value: unknown) {
    const state = readContentFindState(value);
    if (state.id !== this.state?.id || state.query !== this.state.query) return;
    this.state = state;
    if (this.window && !this.window.isDestroyed()) {
      const height = state.error ? 68 : 44;
      if (this.window.getBounds().height !== height) { this.window.setSize(344, height); this.reposition(); }
      this.window.webContents.send('content-find:state', state);
    }
  }

  close(value: unknown) {
    if (readContentFindId(value) !== this.state?.id) return;
    this.state = undefined;
    this.window?.hide();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.window?.destroy(); this.window = undefined;
    this.parent.removeListener('move', this.reposition); this.parent.removeListener('resize', this.reposition);
    this.parent.removeListener('hide', this.hide); this.parent.removeListener('minimize', this.hide);
    ipcMain.removeHandler('content-find:state'); ipcMain.removeHandler('content-find:action');
  }
}
