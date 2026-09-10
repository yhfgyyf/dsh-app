import { BrowserWindow, ipcMain, nativeImage, screen } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DesktopComputerUse } from './computer-use.ts';
import type { ComputerState } from '../shared/computer-use.ts';

/** An isolated, UI-only view of the current target. It cannot enable or drive input. */
export class ComputerPreviewWindow {
  private window?: BrowserWindow;
  private owner?: string;
  private computer: DesktopComputerUse;
  private root: string;
  private returnToApp: () => void;
  constructor(computer: DesktopComputerUse, root: string, returnToApp: () => void) {
    this.computer = computer; this.root = root; this.returnToApp = returnToApp;
    for (const command of ['state', 'frame', 'stop', 'return', 'hide'] as const) {
      ipcMain.handle(`computer-preview:${command}`, async event => {
        const window = this.window;
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(join(this.root, 'dist/renderer/computer-preview/index.html')).href) throw new Error('此页面不能访问电脑操作画中画。');
        switch (command) {
          case 'state': return structuredClone(computer.state);
          case 'frame': {
            const frame = window.isVisible() ? await computer.preview() : undefined;
            if (!frame?.image) return frame;
            const image = nativeImage.createFromBuffer(Buffer.from(frame.image.dataBase64, 'base64'));
            const { width, height } = image.getSize();
            const thumbnail = Math.max(width, height) > 640 ? image.resize(width >= height ? { width: 640 } : { height: 640 }) : image;
            return { ...frame, image: { mimeType: 'image/png', dataBase64: thumbnail.toPNG().toString('base64') } };
          }
          case 'stop': return computer.stop();
          case 'return': this.returnToApp(); return;
          case 'hide': window.hide(); return;
        }
      });
    }
  }
  update(state: ComputerState) {
    this.window?.webContents.send('computer-preview:state', state);
    if (!state.enabled || state.phase !== 'active') {
      this.owner = undefined;
      this.window?.destroy(); this.window = undefined;
    } else if (state.target && this.owner !== state.owner?.sessionId) {
      this.owner = state.owner?.sessionId;
      void this.show().catch(() => { this.owner = undefined; });
    }
  }
  async show() {
    if (!this.computer.state.enabled || this.computer.state.phase !== 'active') return;
    if (this.window && !this.window.isDestroyed()) { this.window.showInactive(); return; }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const window = new BrowserWindow({
      title: 'DSH 电脑操作', width: 380, height: 320, minWidth: 300, minHeight: 260,
      x: area.x + Math.max(0, area.width - 400), y: area.y + Math.max(0, area.height - 340),
      show: false, alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true, focusable: false,
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      backgroundColor: '#171a20', resizable: true, maximizable: false, fullscreenable: false,
      webPreferences: { preload: join(this.root, 'dist/computer-preview-preload/index.cjs'), partition: 'computer-preview', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    this.window = window;
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { event.preventDefault(); window.hide(); });
    window.on('closed', () => { if (this.window === window) this.window = undefined; });
    await window.loadFile(join(this.root, 'dist/renderer/computer-preview/index.html'));
    if (!window.isDestroyed() && this.computer.state.phase === 'active') window.showInactive();
  }
  dispose() {
    this.window?.destroy(); this.window = undefined;
    for (const command of ['state', 'frame', 'stop', 'return', 'hide']) ipcMain.removeHandler(`computer-preview:${command}`);
  }
}
