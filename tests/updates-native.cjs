// Real desktop menu, IPC and React UI with a local release fixture; no model requests.
const { app, BrowserWindow, ipcMain, Menu, webContents } = require('electron');
const assert = require('node:assert/strict');
const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const root = join(__dirname, '..');
const data = join(root, '.test-data', 'updates-native', String(Date.now()));
mkdirSync(data, { recursive: true });
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
const version = '99.99.99';
const name = `DSH-Desktop-${version}-${process.platform === 'darwin' ? 'macOS-arm64.zip' : 'Windows-x64-Setup.exe'}`;
const asset = join(data, name);
if (process.platform === 'darwin') {
  const fixture = join(data, 'DSH Desktop.app');
  mkdirSync(join(fixture, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(fixture, 'Contents/Resources'));
  copyFileSync('/usr/bin/true', join(fixture, 'Contents/MacOS/DSH Desktop'));
  writeFileSync(join(fixture, 'Contents/Resources/app.asar'), 'updater fixture');
  writeFileSync(join(fixture, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.dsh.desktop</string><key>CFBundleExecutable</key><string>DSH Desktop</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', fixture]);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', fixture, asset]);
} else writeFileSync(asset, 'installer fixture; never executed');
const bytes = readFileSync(asset);
const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const report = { checks: [], failures: [], requests: 0 };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (url.startsWith('https://api.github.com/repos/yhfgyyf/dsh-app/releases')) {
    report.requests++;
    return Response.json([{ tag_name: 'v' + version, draft: false, prerelease: true, published_at: '2026-09-09T00:00:00Z', assets: [{ name, state: 'uploaded', size: bytes.length, digest, browser_download_url: `https://github.com/yhfgyyf/dsh-app/releases/download/v${version}/${name}` }] }]);
  }
  if (url === `https://github.com/yhfgyyf/dsh-app/releases/download/v${version}/${name}`) return new Response(bytes);
  return originalFetch(input, options);
};
let finished = false, failed = false, started = false;
const timeout = setTimeout(() => finish(new Error('Update UI test timed out')), 55000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) { const end = Date.now() + 12000; do { const value = await fn(); if (value) return value; await sleep(70); } while (Date.now() < end); throw new Error(message); }
function finish(error) {
  if (finished) return;
  finished = true; failed = !!error; clearTimeout(timeout);
  if (error) report.failures.push(String(error.stack ?? error));
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(root, '.test-data/updates-native/latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.quit();
}
app.on('quit', () => { if (failed) process.exit(1); });
const handles = new Map();
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  handles.set(channel, listener);
  handle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'desktop:ready' && !started) { started = true; setTimeout(() => run(args[0]).then(() => finish()).catch(async error => { report.state = await args[0].sender.executeJavaScript('window.dshDesktop.getUpdateState()').catch(() => null); finish(error); }), 200); }
    return result;
  });
};
async function run(event) {
  const host = event.sender;
  const js = code => host.executeJavaScript(code, true);
  await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='继续')?.click()`);
  await sleep(250);
  await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='稍后配置')?.click()`);
  const menu = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === '检查更新…');
  assert.ok(menu); menu.click();
  await until(() => js(`!!document.querySelector('dialog[open][aria-label="应用更新"]')`), 'Native menu did not open updater');
  await until(() => js(`document.querySelector('dialog[open]').innerText.includes('发现新版本 99.99.99')`), 'Published preview not shown');
  assert.equal(report.requests, 1);
  report.checks.push('Native Check for Updates menu opens the in-app dialog and discovers a published GitHub preview');
  assert.equal((await js('window.dshDesktop.getUpdateState()')).schedule.mode, 'startup');
  await js(`(() => { const select = document.querySelector('dialog[open] select[aria-label="更新检查模式"]'); select.value = 'daily'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(() => js(`!!document.querySelector('dialog[open] input[aria-label="每日检查时间"]')`), 'Daily time control did not appear');
  await js(`window.dshDesktop.setUpdateSchedule({mode:'daily',time:'18:45'})`);
  await until(() => js(`document.querySelector('dialog[open] input[aria-label="每日检查时间"]').value === '18:45'`), 'Daily time did not persist in UI');
  await js(`(() => { const select = document.querySelector('dialog[open] select'); select.value = 'startup'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(() => js(`!document.querySelector('dialog[open] input[aria-label="每日检查时间"]')`), 'Startup mode should hide the daily time control');
  report.checks.push('Update settings switch between startup and a persisted local daily time');
  await js(`Array.from(document.querySelectorAll('dialog[open] button')).find(b=>b.textContent==='下载更新').click()`);
  await until(() => js(`document.querySelector('dialog[open]').innerText.includes('已下载并通过校验')`), 'Download did not become ready');
  report.checks.push('Update download passes SHA-256 and platform validation before enabling Restart and Install');
  await js(`Array.from(document.querySelectorAll('dialog[open] button')).find(b=>b.textContent==='重启并安装').click()`);
  await until(() => js(`document.querySelector('dialog[open]').innerText.includes('已安装的 DSH Desktop')`), 'Development app should not replace an installation');
  report.checks.push('A development build cannot replace the installed app');
  const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await foreign.loadURL('about:blank');
  assert.throws(() => handles.get('desktop:update-install')({ sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame }), /不能调用/);
  foreign.destroy();
  assert.ok(webContents.getAllWebContents().includes(host));
  report.checks.push('Foreign pages cannot check, download or install through privileged desktop IPC');
}
app.setAppPath(root);
require('../dist/main/index.cjs');
