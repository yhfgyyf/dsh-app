import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, screen, session, shell } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, extname, resolve } from 'node:path';
import { defaultPreferences, isEndpointDocument, parseConnectionInput } from '../shared/config.ts';
import type { DesktopPreferences } from '../shared/config.ts';
import { externalWebUrl } from '../shared/desktop-api.ts';
import type { DesktopCommand, DesktopInfo } from '../shared/desktop-api.ts';
import { PreferencesFile } from './preferences.ts';
import { createDshTransport } from './transport.ts';
import { DesktopRuntime } from './runtime.ts';
import { SidebarBrowser } from './sidebar-browser.ts';
import { DesktopUpdates } from './updates.ts';
import { installTextContextMenu } from './context-menu.ts';
import { openLocal } from './local-open.ts';

app.setName('DSH Desktop');
const customData = process.env.DSH_DESKTOP_DATA_DIR;
if (customData && isAbsolute(customData)) app.setPath('userData', customData);
else app.setPath('userData', join(app.getPath('appData'), 'DSH Desktop'));

protocol.registerSchemesAsPrivileged(['dsh', 'dsh-preview'].map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } })));

const ownInstance = app.requestSingleInstanceLock();
if (!ownInstance) app.quit();
else {
  let window: BrowserWindow | undefined;
  let preferences: DesktopPreferences = defaultPreferences();
  let preferencesFile: PreferencesFile;
  let runtime: DesktopRuntime;
  let browser: SidebarBrowser | undefined;
  let updates: DesktopUpdates;
  let connected = false;
  let connecting = false;
  let connectionError: string | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let quitting = false;
  const resources = join(app.getAppPath(), 'dist', 'renderer');
  const setupUrl = 'dsh://app/index.html';

  function info(): DesktopInfo {
    return { name: 'DSH Desktop', version: app.getVersion(), endpoint: preferences.endpoint, connected, connecting, error: connectionError, zoomFactor: preferences.zoomFactor, platform: process.platform };
  }

  function isSetupDocument(value: string) {
    try {
      const url = new URL(value);
      return url.protocol === 'dsh:' && url.hostname === 'app' && url.pathname === '/index.html';
    } catch { return false; }
  }

  function assertSender(event: IpcMainInvokeEvent) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        (!isSetupDocument(event.senderFrame.url) && !isEndpointDocument(event.senderFrame.url, preferences.endpoint))) {
      throw new Error('此页面不能调用桌面接口。');
    }
  }

  async function savePreferences() {
    if (window && !window.isDestroyed()) {
      preferences = { ...preferences, window: { ...window.getNormalBounds(), maximized: window.isMaximized() } };
    }
    try { await preferencesFile.save(preferences); }
    catch { connectionError = '桌面配置保存失败，原文件已保留。'; }
  }

  function scheduleSave() {
    if (window && !window.isDestroyed()) preferences.window = { ...window.getNormalBounds(), maximized: window.isMaximized() };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void savePreferences(); }, 250);
  }

  async function showConnection(error?: string) {
    connected = false;
    if (error) connectionError = error;
    if (window && !window.isDestroyed()) await window.loadURL(setupUrl);
  }

  function sendCommand(command: DesktopCommand) {
    if (window && !window.isDestroyed() && isEndpointDocument(window.webContents.getURL(), preferences.endpoint)) {
      window.webContents.send('desktop:command', command);
    }
  }

  function openSidebarLink(value: string) {
    const url = externalWebUrl(value);
    if (url && window && !window.isDestroyed()) window.webContents.send('desktop:open-link', url);
  }

  function applyZoom(value: number) {
    preferences.zoomFactor = Math.max(0.5, Math.min(2, Math.round(value * 10) / 10));
    window?.webContents.setZoomFactor(preferences.zoomFactor);
    scheduleSave();
  }

  function installMenu() {
    const template: MenuItemConstructorOptions[] = [
      { label: 'DSH Desktop', submenu: [{ role: 'about', label: '关于 DSH Desktop' }, { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('settings') }, { label: '运行状态…', accelerator: 'CmdOrCtrl+Shift+,', click: () => { void showConnection(); } }, { type: 'separator' }, { role: 'hide', label: '隐藏 DSH Desktop' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '显示全部' }, { type: 'separator' }, { role: 'quit', label: '退出 DSH Desktop' }] },
      { label: '文件', submenu: [{ label: '新建会话', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-session') }, { label: '搜索会话', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('search') }, { type: 'separator' }, { role: 'close', label: '关闭窗口' }] },
      { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
      { label: '视图', submenu: [{ label: '切换侧边栏', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('sidebar') }, { label: '打开右侧面板', accelerator: 'CmdOrCtrl+Shift+I', click: () => sendCommand('details') }, { type: 'separator' }, { role: 'reload', label: '重新加载' }, { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => applyZoom(preferences.zoomFactor + 0.1) }, { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => applyZoom(preferences.zoomFactor - 0.1) }, { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => applyZoom(1) }, { type: 'separator' }, { role: 'togglefullscreen', label: '切换全屏' }, { role: 'toggleDevTools', label: '开发者工具' }] },
      { role: 'windowMenu', label: '窗口' },
      { label: '帮助', submenu: [{ label: 'DSH 项目', click: () => { void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness'); } }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    app.setAboutPanelOptions({ applicationName: 'DSH Desktop', applicationVersion: app.getVersion(), copyright: 'Independent desktop client for DeepSeek Harness' });
  }

  async function createWindow() {
    const bounds = preferences.window;
    const visible = bounds.x !== undefined && bounds.y !== undefined && screen.getAllDisplays().some(({ workArea }) =>
      bounds.x! + bounds.width > workArea.x + 80 && bounds.x! < workArea.x + workArea.width - 80 &&
      bounds.y! + bounds.height > workArea.y + 80 && bounds.y! < workArea.y + workArea.height - 80);
    window = new BrowserWindow({
      width: bounds.width, height: bounds.height,
      ...(visible ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: 640, minHeight: 480, show: false,
      title: 'DSH Desktop',
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 16 } } : {}),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#f6f6f6',
      webPreferences: { preload: join(app.getAppPath(), 'dist', 'preload', 'index.cjs'), partition: 'persist:dsh', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    if (bounds.maximized) window.maximize();
    installTextContextMenu(window.webContents, window);
    browser = new SidebarBrowser(window, () => preferences.endpoint, openSidebarLink);
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) browser?.clear(); });
    window.once('ready-to-show', () => window?.show());
    window.on('resize', scheduleSave);
    window.on('move', scheduleSave);
    window.on('close', scheduleSave);
    window.on('closed', () => { browser?.clear(); browser = undefined; window = undefined; connected = false; });
    window.webContents.on('did-finish-load', () => window?.webContents.setZoomFactor(preferences.zoomFactor));
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.alt || !(input.meta || input.control) || input.isAutoRepeat) return;
      const key = input.key.toLowerCase();
      const command: DesktopCommand | undefined = input.shift ? (key === 'i' ? 'details' : undefined) : ({ n: 'new-session', b: 'sidebar', f: 'search', ',': 'settings' } as const)[key as 'n' | 'b' | 'f' | ','];
      if (command) { event.preventDefault(); sendCommand(command); }
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (isSetupDocument(url) || isEndpointDocument(url, preferences.endpoint)) return;
      event.preventDefault();
      openSidebarLink(url);
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      openSidebarLink(url);
      return { action: 'deny' };
    });
    window.webContents.on('render-process-gone', () => { void showConnection('界面进程已退出。请重新加载界面。'); });
    await window.loadURL(setupUrl);
  }

  async function connect(): Promise<{ ok: boolean; error?: string }> {
    if (connecting) return { ok: false, error: '正在启动，请稍候。' };
    connecting = true;
    connectionError = undefined;
    try {
      const running = runtime.ready !== undefined;
      const ready = await runtime.start();
      preferences.endpoint = ready.endpoint;
      const ses = session.fromPartition('persist:dsh');
      if (!running) {
        const response = await ses.fetch(ready.launchUrl, { credentials: 'include', bypassCustomProtocolHandlers: true, signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(`DSH 核心认证失败 (${response.status})。`);
      }
      await window?.loadURL(ready.endpoint + '/');
      return { ok: true };
    } catch (error) {
      connectionError = error instanceof Error ? error.message : 'DSH 核心启动失败。';
      await showConnection();
      return { ok: false, error: connectionError };
    } finally { connecting = false; }
  }

  async function installProtocols() {
    const ses = session.fromPartition('persist:dsh');
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
    const setupAssets = new Map<string, string>();
    async function collect(directory: string, prefix = '/') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await collect(join(directory, entry.name), prefix + entry.name + '/');
        else if (entry.isFile()) setupAssets.set(prefix + entry.name, join(directory, entry.name));
      }
    }
    await collect(join(resources, 'setup'));
    ses.protocol.handle('dsh', async (request) => {
      const url = new URL(request.url);
      const path = url.hostname === 'app' ? setupAssets.get(url.pathname) : undefined;
      if (!path || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
      return new Response(request.method === 'HEAD' ? null : await readFile(path), { headers: { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'", 'x-content-type-options': 'nosniff' } });
    });
    const appAssets = new Map<string, string>();
    async function collectApp(directory: string, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await collectApp(join(directory, entry.name), prefix + entry.name + '/');
        else appAssets.set('app/' + prefix + entry.name, join(directory, entry.name));
      }
    }
    await collectApp(join(resources, 'app'));
    for (const name of ['plugin.js', 'theme.css']) appAssets.set(name, join(resources, name));
    const handle = createDshTransport({
      getEndpoint: () => preferences.endpoint,
      fetch: (request) => ses.fetch(request, { bypassCustomProtocolHandlers: true }),
      getAsset: async (name) => {
        const path = appAssets.get(name);
        return path ? { body: await readFile(path), contentType: types[extname(path)] ?? 'application/octet-stream' } : undefined;
      },
    });
    ses.protocol.handle('http', handle);
    ses.protocol.handle('https', handle);
    ses.setPermissionRequestHandler((contents, permission, callback) => {
      callback(contents === window?.webContents && isEndpointDocument(contents.getURL(), preferences.endpoint) && permission === 'clipboard-sanitized-write');
    });
    ses.setPermissionCheckHandler((contents, permission, origin) => contents === window?.webContents && origin === preferences.endpoint && permission === 'clipboard-sanitized-write');
    ses.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: '保存 DSH 文件', defaultPath: join(app.getPath('downloads'), item.getFilename()) });
    });
  }

  function installIpc() {
    const handle = (channel: string, callback: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => { assertSender(event); return callback(...args); });
    handle('desktop:update-state', () => updates.state);
    handle('desktop:update-schedule', value => updates.setSchedule(value));
    handle('desktop:update-check', () => updates.check());
    handle('desktop:update-download', () => updates.download());
    handle('desktop:update-install', () => updates.install());
    handle('desktop:info', info);
    handle('desktop:boot', () => runtime.graph());
    handle('desktop:connect', connect);
    handle('desktop:connection', () => showConnection());
    handle('desktop:reconnect', () => connect());
    handle('desktop:ready', () => { connected = true; connectionError = undefined; });
    handle('desktop:color-scheme', (scheme: unknown) => {
      if (scheme !== 'light' && scheme !== 'dark') throw new Error('外观参数无效。');
      window?.setBackgroundColor(scheme === 'dark' ? '#181818' : '#f6f6f6');
    });
    handle('desktop:external', (value: unknown) => {
      const url = externalWebUrl(value);
      if (!url) throw new Error('此链接不能在外部浏览器打开。');
      return shell.openExternal(url);
    });
    handle('desktop:local-open', request => {
      if (!window) throw new Error('窗口已关闭。');
      return openLocal(window, request);
    });
    handle('desktop:browser-open', (id, target, navigation) => browser?.open(id, target, navigation));
    handle('desktop:browser-bounds', (id, bounds) => browser?.bounds(id, bounds));
    handle('desktop:browser-navigate', (id, url) => browser?.navigate(id, url));
    handle('desktop:browser-action', (id, action) => browser?.action(id, action));
    handle('desktop:browser-close', (id) => browser?.close(id));
  }

  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    preferencesFile = new PreferencesFile(app.getPath('userData'));
    try { preferences = await preferencesFile.load(); }
    catch { connectionError = '已有桌面配置无法读取，原文件已保留。'; }
    runtime = new DesktopRuntime({
      runtimeRoot: app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), '.runtime'),
      entry: join(app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), '.runtime'), 'app/index.ts'),
      home: join(app.getPath('userData'), 'core'),
      configHome: resolve(process.env.DSH_DESKTOP_CONFIG_HOME ?? process.env.DSH_HOME ?? join(app.getPath('home'), '.dsh')),
      cwd: app.getPath('home'),
      pickDirectory: async () => {
        if (!window) return null;
        const result = await dialog.showOpenDialog(window, { title: '选择工作区', buttonLabel: '选择工作区', properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
      onExit: () => { connected = false; if (!quitting) void showConnection('DSH 核心已退出，请重新启动。'); },
    });
    await installProtocols();
    updates = new DesktopUpdates({
      currentVersion: app.getVersion(), platform: process.platform, arch: process.arch,
      home: join(app.getPath('userData'), 'updates'), appPath: app.getAppPath(),
      runtimeRoot: app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), '.runtime'),
      executable: process.execPath, packaged: app.isPackaged,
      corePid: () => runtime.child?.pid, quit: () => app.quit(),
      publish: state => { if (window && !window.isDestroyed()) window.webContents.send('desktop:update-state', state); },
    });
    await updates.restoreResult();
    installIpc();
    installMenu();
    await createWindow();
    await connect();
    updates.start();
  }).catch(() => {
    console.error('DSH Desktop 无法启动。请检查应用资源和配置目录。');
    app.quit();
  });
  app.on('activate', () => { if (!window) void createWindow().then(() => connect()); else window.show(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !quitting) app.quit(); });
  app.on('before-quit', (event) => {
    if (quitting || !preferencesFile) return;
    event.preventDefault();
    quitting = true;
    updates?.stop();
    clearTimeout(saveTimer);
    void savePreferences().then(async () => { browser?.clear(); window?.destroy(); await runtime?.stop(); }).finally(() => app.quit());
  });
}
