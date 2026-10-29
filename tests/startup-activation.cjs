// Exercise macOS activation while asynchronous desktop initialization is pending.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const childProcess = require('node:child_process');
const root = join(__dirname, '..');
mkdirSync(join(root, '.test-data'), { recursive: true });
const data = mkdtempSync(join(root, '.test-data/startup-activation-'));
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'config');
process.env.DSH_TELEMETRY_DISABLED = '1';
const report = { ready: false, checks: [], failures: [], coreStopped: false };
const clean = value => String(value).replace(/token=[^\s&"']+/g, 'token=[redacted]');
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (String(args[1]?.[0]).replaceAll('\\', '/').endsWith('/app/index.ts')) report.corePid = child.pid;
  return child;
};
let finished = false;
function finish(error) {
  if (error) report.failures.push(clean(error.stack ?? error));
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  app.quit();
}
const timeout = setTimeout(() => finish(new Error('Desktop activation startup timed out')), 50000);
process.on('unhandledRejection', error => report.failures.push(clean(error.stack ?? error)));
process.on('exit', () => {
  if (!report.ready) report.failures.push('Desktop never became ready');
  if (report.corePid) try { process.kill(report.corePid, 0); } catch { report.coreStopped = true; }
  if (report.corePid && !report.coreStopped) report.failures.push('Owned core survived app shutdown');
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, data }, null, 2));
  if (report.failures.length) process.exit(1);
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) report.failures.push(`${code}: ${description} (${clean(url)})`);
  });
});
const handle = ipcMain.handle.bind(ipcMain);
const handlers = new Map();
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener);
  return handle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'desktop:ready' && !report.ready) {
      report.ready = true;
      try {
        assert.equal((await handlers.get('desktop:info')(args[0])).connected, true);
        const windows = BrowserWindow.getAllWindows();
        assert.equal(windows.length, 1, 'Early activation created an extra window');
        const window = windows[0];
        window.hide();
        app.emit('activate', {}, false);
        assert.equal(window.isVisible(), true);
        app.emit('activate', {}, true);
        assert.deepEqual(BrowserWindow.getAllWindows().map(window => window.id), [window.id]);
        report.checks.push('Early activation waits for protocol and IPC initialization; only one main window is created', 'Activation after startup restores the same ready window', 'Bundled host and renderer become ready without a failed main-frame load');
        finish();
      } catch (error) { finish(error); }
    }
    return result;
  });
};
// This callback runs before main's ready callback and its first asynchronous read.
app.whenReady().then(() => {
  app.emit('activate', {}, false);
  app.emit('activate', {}, true);
});
app.setAppPath(root);
require('../dist/main/index.cjs');
