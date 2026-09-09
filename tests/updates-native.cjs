// Production title-bar icon and IPC with a local release fixture; no model requests.
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
  await js(`Array.from(document.querySelectorAll('button')).find(b=>['继续','Continue'].includes(b.textContent))?.click()`);
  await sleep(250);
  await js(`Array.from(document.querySelectorAll('button')).find(b=>['稍后配置','Configure later'].includes(b.textContent))?.click()`);
  assert.equal(Menu.getApplicationMenu().items[0].submenu.items.some(item => item.label.includes('检查更新')), false);
  assert.equal(await js(`!!document.querySelector('dialog[aria-label="应用更新"]')`), false);
  assert.equal(await js(`!!document.querySelector('.desktop-update-icon')`), false);
  // The packaged test exercises the startup timer; this fixture injects discovery through IPC.
  await js('window.dshDesktop.checkForUpdates()');
  await until(() => js(`!!document.querySelector('.desktop-update-icon[data-update-state="available"]')`), 'Available update icon missing');
  assert.equal(report.requests, 1);
  assert.equal(await js(`document.querySelector('.desktop-update-icon').textContent.trim()`), '');
  assert.equal(await js(`!!document.querySelector('.desktop-update-icon svg')`), true);
  assert.equal(await js(`Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes('检查更新'))`), false);
  report.checks.push('GitHub discovery shows only a title-bar icon; no updater dialog or manual check entry exists');
  await js(`document.querySelector('.desktop-update-icon').click()`);
  await until(() => js(`!!document.querySelector('.desktop-update-icon[data-update-state="ready"]')`), 'One click did not download and validate the update');
  assert.match(await js(`document.querySelector('.desktop-update-icon').title`), /点击重启安装/);
  report.checks.push('One icon click downloads and validates the update, then offers restart through the same icon');
  assert.equal((await js('window.dshDesktop.getUpdateState()')).schedule.mode, 'startup');
  await js(`window.dshDesktop.setUpdateSchedule({mode:'daily',time:'18:45'})`);
  assert.deepEqual((await js('window.dshDesktop.getUpdateState()')).schedule, { mode: 'daily', time: '18:45' });
  await js(`window.dshDesktop.setUpdateSchedule({mode:'startup',time:'18:45'})`);
  report.checks.push('Automatic update schedule persists between startup and a chosen local daily time');
  writeFileSync(join(data, 'update-icon.png'), (await host.capturePage()).toPNG());
  await js(`document.querySelector('.desktop-update-icon').click()`);
  await until(() => js(`document.querySelector('.desktop-update-icon').title.includes('已安装的 DSH Desktop')`), 'Development app should not replace an installation');
  assert.equal(await js(`!!document.querySelector('dialog[aria-label="应用更新"]')`), false);
  report.checks.push('Installation errors stay on the icon and a development build cannot replace the installed app');
  const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await foreign.loadURL('about:blank');
  assert.throws(() => handles.get('desktop:update-install')({ sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame }), /不能调用/);
  foreign.destroy();
  assert.ok(webContents.getAllWebContents().includes(host));
  report.checks.push('Foreign pages cannot check, download or install through privileged desktop IPC');
}
app.setAppPath(root);
require('../dist/main/index.cjs');
