// Exercise the Windows helper against the same Electron menu before packaging.
const { app, BrowserWindow, Menu } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
if (process.platform !== 'win32') throw new Error('Windows menu fixture requires Windows');
let quitRequested = false;
let helper;
const deadline = setTimeout(() => { console.error('Windows Quit menu fixture timed out'); app.exit(1); }, 20000);
app.on('before-quit', () => {
  quitRequested = true;
  clearTimeout(deadline);
  console.log('PASS: Windows helper invokes the actual Electron Quit menu.');
});
process.on('exit', () => { if (!quitRequested) helper?.kill(); });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'DSH Desktop', submenu: [{ role: 'quit', label: '退出 DSH Desktop' }] },
  ]));
  const window = new BrowserWindow({ width: 640, height: 400 });
  await window.loadURL('data:text/html,<title>Windows Quit menu fixture</title>');
  window.show(); window.focus();
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', join(__dirname, '../scripts/quit-windows-test-app.ps1'), '-ApplicationId', String(process.pid)], { stdio: 'inherit' });
  helper.on('error', error => { console.error(error); app.exit(1); });
  helper.on('exit', code => { if (code !== 0 && !quitRequested) app.exit(1); });
}).catch(error => { console.error(error); app.exit(1); });
