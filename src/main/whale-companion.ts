import { app, BrowserWindow, ipcMain, powerMonitor, screen } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const width = 192, height = 182;
const kinds = new Set(['begin', 'end', 'work-start', 'work-end', 'clear', 'investigate', 'replay', 'adopted', 'retained', 'completed']);
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
type Anchor = { display: number; x: number; y: number };
type Gesture = { cursor: Electron.Point; origin: Electron.Rectangle; moved: boolean; body: boolean; second: boolean };
type Notice = { id: string; kind: string };
type Preferences = { enabled: boolean; mic: boolean; compact: boolean; sound: boolean; complete: boolean; volume: number; style: string };

// Electron's panel stays inactive, but AppKit normally orders it out on Cmd+H.
function configureNativeClicks(win: BrowserWindow): number {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 500;
  const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), '.runtime');
  const requireRuntime = createRequire(join(runtime, 'package.json'));
  if (process.platform === 'win32') {
    try { return requireRuntime('koffi').load('user32.dll').func('unsigned int __stdcall GetDoubleClickTime()')() || 500; }
    catch { return 500; }
  }
  const koffi = requireRuntime('koffi');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const selector = objc.func('void *sel_registerName(const char *name)');
  const getWindow = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const setFlag = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool']);
  const view = win.getNativeWindowHandle().readBigUInt64LE();
  const panel = getWindow(view, selector('window'));
  setFlag(panel, selector('setCanHide:'), false);
  const responds = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *']);
  const preventActivation = selector('_setPreventsActivation:');
  if (responds(panel, selector('respondsToSelector:'), preventActivation)) setFlag(panel, preventActivation, true);
  const getClass = objc.func('void *objc_getClass(const char *name)');
  const interval = objc.func('objc_msgSend', 'double', ['void *', 'void *']);
  return Math.round(1000 * interval(getClass('NSEvent'), selector('doubleClickInterval'))) || 500;
}

// One non-activating window for the profile, independent of the conversation window.
export class WhaleCompanion {
  private win?: BrowserWindow;
  private doubleClickMs = 500;
  private pendingTap?: { cursor: Electron.Point; timer: NodeJS.Timeout };
  private prefs?: Preferences;
  private anchor?: Anchor;
  private hidden = false;
  private locked = false;
  private water = false;
  private ready = false;
  private ignore?: boolean;
  private poll?: NodeJS.Timeout;
  private gesture?: Gesture;
  private tapUntil = 0;
  private queued: Notice[] = [];
  private rows: number[] = [];
  private meshWidth = 108;
  private meshHeight = 123;
  private input = { id: '', action: null as string | null, busy: false };
  private readonly file = join(app.getPath('userData'), 'sim-companion.json');
  constructor(private main: () => BrowserWindow | undefined, private restore: () => void) {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8'));
      this.hidden = v.hidden === true;
      if (Number.isFinite(v.anchor?.x) && Number.isFinite(v.anchor?.y)) this.anchor = v.anchor;
    } catch { /* First launch. */ }
    if (process.platform === 'win32') {
      this.locked = powerMonitor.getSystemIdleState(1) === 'locked';
      powerMonitor.on('lock-screen', () => {
        if (this.locked) return;
        this.locked = true;
        if (this.win && this.gesture?.moved) {
          try { this.saveAnchor(); } catch { /* The display may already be detached. Keep the last saved position. */ }
        }
        // Windows can switch input desktops without delivering the last pointer-up.
        this.destroyWindow();
      });
      powerMonitor.on('unlock-screen', () => {
        if (!this.locked) return;
        this.locked = false;
        if (this.prefs) this.configure(this.prefs);
      });
    }
    ipcMain.on('whale:input', (e, action, ...args) => {
      if (this.win && e.sender === this.win.webContents && e.senderFrame === e.sender.mainFrame) this.control(action, args);
    });
    ipcMain.handle('whale:up', e => {
      if (!this.win || e.sender !== this.win.webContents || e.senderFrame !== e.sender.mainFrame || !this.gesture) return false;
      this.tick();
      const gesture = this.gesture;
      this.gesture = undefined;
      const tapped = !gesture.moved;
      if (!tapped) this.saveAnchor();
      else if (gesture.body && !this.water) {
        if (gesture.second) this.restore();
        else this.waitForSecondTap(gesture.cursor);
      }
      // Older companion renderers send a separate dictate message after a tap.
      this.tapUntil = tapped && !gesture.body ? Date.now() + 750 : 0;
      return tapped;
    });
    const reposition = () => this.position();
    screen.on('display-added', reposition);
    screen.on('display-removed', reposition);
    screen.on('display-metrics-changed', reposition);
  }
  configure(value: Preferences | null) {
    if (!value) { this.close(); return; }
    this.prefs = { enabled:value.enabled === true, mic:value.mic === true, compact:value.compact === true,
      sound:value.sound === true, complete:value.complete === true, volume:clamp(Number(value.volume) || 0, 0, 1),
      style:['bubble','cotton','bell'].includes(value.style) ? value.style : 'bubble' };
    if (this.locked) return;
    if (this.win) { this.sync(); return; }
    const page = join(app.getPath('userData'), 'core/profiles/desktop/node_modules/dsh-sim/desktop/whale.html');
    if (!existsSync(page)) return;
    this.water = this.hidden;
    const win = this.win = new BrowserWindow({ width, height, show:false, frame:false, transparent:true,
      focusable:false, acceptFirstMouse:true, skipTaskbar:true, hasShadow:false, resizable:false, fullscreenable:false,
      ...(process.platform === 'darwin' ? { type:'panel' as const } : {}),
      webPreferences:{ preload:join(app.getAppPath(),'dist/whale-preload/index.cjs'), sandbox:true,
        contextIsolation:true, nodeIntegration:false, partition:'sim-companion', backgroundThrottling:false,
        autoplayPolicy:'no-user-gesture-required' } });
    this.doubleClickMs = configureNativeClicks(win);
    win.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc,_perm,done) => done(false));
    win.setAlwaysOnTop(true, 'floating'); this.position();
    win.setIgnoreMouseEvents(true, {forward:true}); this.ignore = true;
    win.once('closed', () => { if (this.win === win) this.close(); });
    void win.loadFile(page).catch(() => { if (this.win === win) this.close(); });
    this.poll = setInterval(() => this.tick(), 24);
  }
  updateInput(id: unknown, action: unknown, busy: unknown) {
    if (typeof id !== 'string' || id.length > 256) return;
    this.input = { id, action: typeof action === 'string' && ['start','stop','retryRecording'].includes(action) ? action : null, busy:busy === true };
    this.sync();
  }
  notice(id: unknown, kind: unknown) {
    if (kind === 'offline') { this.close(); return; }
    if (typeof id !== 'string' || id.length > 256 || typeof kind !== 'string' || !kinds.has(kind)) return;
    if (this.ready) this.win?.webContents.send('whale:notice', { id, kind });
    else if (this.win || (this.locked && this.prefs)) { if (this.queued.length === 64) this.queued.shift(); this.queued.push({id,kind}); }
  }
  reset() { this.anchor = undefined; this.position(); this.save(); }
  close() {
    this.prefs = undefined; this.queued = [];
    this.destroyWindow();
  }
  private destroyWindow() {
    this.clearTap();
    clearInterval(this.poll); this.poll = undefined;
    this.ready = false; this.rows = []; this.gesture = undefined; this.tapUntil = 0;
    const win = this.win; this.win = undefined;
    if (win && !win.isDestroyed()) win.destroy();
  }
  private clearTap() {
    clearTimeout(this.pendingTap?.timer);
    this.pendingTap = undefined;
  }
  private waitForSecondTap(cursor: Electron.Point) {
    const { id, action } = this.input;
    const mic = this.prefs?.mic;
    const timer = setTimeout(() => {
      this.pendingTap = undefined;
      const main = this.main();
      if (mic && this.prefs?.mic && action && this.input.id === id && this.input.action === action &&
          !this.water && main && !main.isDestroyed()) main.webContents.send('whale:dictate', id, action);
    }, this.doubleClickMs);
    this.pendingTap = { cursor, timer };
  }
  private control(action: string, args: unknown[]) {
    const win = this.win!;
    switch (action) {
      case 'ready':
        this.ready = true; this.sync(); win.showInactive();
        for (const event of this.queued.splice(0)) win.webContents.send('whale:notice',event);
        break;
      case 'mask': {
        const [w,h,rows] = args;
        if ((w === 108 && h === 123 || w === 54 && h === 62) && Array.isArray(rows) && rows.length === 28 && rows.every(n => Number.isInteger(n) && n >= 0 && n < 1<<24)) {
          this.meshWidth = w; this.meshHeight = h; this.rows = rows;
        }
        break;
      }
      case 'water': this.water = args[0] === true; if (this.water) this.clearTap(); break;
      case 'hidden': this.hidden = args[0] === true; this.save(); break;
      case 'down': {
        const cursor = screen.getCursorScreenPoint(), previous = this.pendingTap?.cursor;
        const body = args[0] === 'buddy' && !this.water;
        const second = body && !!previous && Math.hypot(cursor.x - previous.x, cursor.y - previous.y) < 6;
        this.clearTap();
        this.tapUntil = 0;
        this.gesture = { cursor, origin: win.getBounds(), moved: false, body, second };
        break;
      }
      case 'cancel': this.clearTap(); if (this.gesture?.moved) this.saveAnchor(); this.gesture = undefined; this.tapUntil = 0; break;
      case 'dictate': {
        if (Date.now() > this.tapUntil || this.water || !this.prefs?.mic || !this.input.action || args[0] !== this.input.id || args[1] !== this.input.action) return;
        this.tapUntil = 0;
        const main = this.main();
        if (main && !main.isDestroyed()) main.webContents.send('whale:dictate', this.input.id, this.input.action);
        break;
      }
    }
  }
  private sync() { if (this.ready) this.win?.webContents.send('whale:state', {prefs:this.prefs, input:this.input, hidden:this.hidden}); }
  private tick() {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (this.gesture) {
      const g = this.gesture, dx = p.x - g.cursor.x, dy = p.y - g.cursor.y;
      if (Math.hypot(dx,dy) >= 6) g.moved = true;
      if (g.moved) {
        const a = screen.getDisplayNearestPoint(p).workArea;
        const x = clamp(g.origin.x+dx,a.x,a.x+a.width-width), y = clamp(g.origin.y+dy,a.y,a.y+a.height-height);
        const [ox,oy] = win.getPosition(); if (ox !== x || oy !== y) win.setPosition(x,y,false);
      }
      return;
    }
    const [left,top] = win.getPosition(), x = p.x-left, y = p.y-top;
    const col = Math.floor((x-(width-this.meshWidth)/2)*24/this.meshWidth);
    const row = Math.floor((y-(height-12-this.meshHeight))*28/this.meshHeight);
    const hit = this.water ? Math.abs(x-width/2) < 20 && y >= height-40 && y < height :
      col >= 0 && col < 24 && row >= 0 && row < 28 && !!(this.rows[row] & (1<<col));
    if (this.ignore !== !hit) { win.setIgnoreMouseEvents(!hit, {forward:true}); this.ignore = !hit; }
  }
  private position() {
    if (!this.win) return;
    const d = screen.getAllDisplays().find(d => d.id === this.anchor?.display) ?? screen.getPrimaryDisplay(), a = d.workArea;
    const x = this.anchor?.x ?? 1, y = this.anchor?.y ?? 0.96;
    this.win.setPosition(a.x+Math.round(clamp(x,0,1)*Math.max(0,a.width-width)),a.y+Math.round(clamp(y,0,1)*Math.max(0,a.height-height)),false);
  }
  private saveAnchor() {
    const b = this.win!.getBounds(), d = screen.getDisplayMatching(b), a = d.workArea;
    this.anchor = { display:d.id, x:(b.x-a.x)/Math.max(1,a.width-width), y:(b.y-a.y)/Math.max(1,a.height-height) }; this.save();
  }
  private save() {
    try { writeFileSync(this.file+'.tmp', JSON.stringify({hidden:this.hidden,anchor:this.anchor}), {mode:0o600}); renameSync(this.file+'.tmp',this.file); }
    catch { /* Still keep this session's position if userData is read-only. */ }
  }
}
