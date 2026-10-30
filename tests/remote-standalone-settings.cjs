const { app, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const root = join(__dirname, '..');
assert.equal(existsSync(join(root, '.runtime/node_modules/dsh-p2p-collab')), false, 'Run against a package fixture without the collaboration plugin');
assert.equal(existsSync(join(root, '.runtime/plugins/dsh-p2p-collab')), false);
assert.equal(JSON.parse(readFileSync(join(root, '.runtime/package.json'))).dependencies['dsh-p2p-collab'], undefined);
mkdirSync(join(root, '.test-data'), { recursive: true });
const data = mkdtempSync(join(root, '.test-data/remote-standalone-'));
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
const report = { checks: [], errors: [] };
const handlers = new Map();
let started = false, finished = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timer = setTimeout(() => finish(new Error('Standalone connection settings timed out')), 60000);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(timer);
  if (error) report.errors.push(String(error));
  writeFileSync(join(data, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ data, ...report }));
  app.quit();
}
app.on('quit', () => { if (report.errors.length) process.exitCode = 1; });
const original = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener);
  return original(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'desktop:ready' && !started) { started = true; setTimeout(() => run(args[0]).then(() => finish()).catch(finish), 100); }
    return result;
  });
};
async function run(event) {
  const host = event.sender;
  const js = code => host.executeJavaScript(code, true);
  async function until(check, message) { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(100); } throw new Error(message); }
  await until(() => js(`(() => {
    const next = Array.from(document.querySelectorAll('button')).find(b => ['继续','Continue','稍后配置','Configure later'].includes(b.textContent));
    if (next) { if (!next.disabled) next.click(); return false; }
    return document.getElementById('root')?.inert === false && !!document.querySelector('[data-conversation-content][data-conversation-session]:not([data-conversation-session=""]) [contenteditable="true"][data-phase="plain"]');
  })()`), 'Onboarding did not finish');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const direct = await js(`(() => { const trigger = document.querySelector('button.VOzbGW_trigger'); if (trigger) { trigger.click(); return true; } document.querySelector('button[aria-label="账号菜单"],button[aria-label="Account menu"]').click(); return false; })()`);
  if (!direct) await until(() => js(`(() => {const b=Array.from(document.querySelectorAll('button[role="menuitem"]')).find(b=>Array.from(b.querySelectorAll('span')).some(s=>['设置','Settings'].includes(s.textContent)));if(!b)return false;b.click();return true;})()`), 'Settings missing');
  await until(() => js('!!document.querySelector(".desktop-general-settings")'), 'General settings missing');
  assert.equal(await js('!!document.querySelector(".desktop-remote-settings")'), false);
  await js(`Array.from(document.querySelectorAll('.desktop-general-settings button')).find(b=>b.textContent==='管理连接').click()`);
  await until(() => js('!!document.querySelector(".desktop-general-settings .desktop-remote-panel input[type=url]")'), 'Connection settings missing without a plugin');
  report.checks.push('General Settings exposes relay registration and phone controls without dsh-p2p-collab installed');
  await js(`Array.from(document.querySelectorAll('.desktop-remote-panel button')).find(b=>b.textContent==='扫码绑定手机').click()`);
  await until(() => js('!!document.querySelector(".desktop-remote-pair img")'), 'Standalone QR generation failed');
  const state = await handlers.get('desktop:remote-state')(event);
  assert.equal(state.registered, false);
  assert.equal(state.config.enabled, true);
  assert.ok(state.pairing.qr.startsWith('data:image/png;base64,'));
  writeFileSync(join(data, 'management.png'), (await host.capturePage()).toPNG());
  report.checks.push('The standalone entry generates a real pairing QR through production IPC and the owned desktop runtime');
  await js(`Array.from(document.querySelectorAll('.desktop-remote-panel button')).find(b=>b.textContent==='取消配对').click()`);
  await until(async () => !(await handlers.get('desktop:remote-state')(event)).pairing, 'Pair cancellation failed');
  report.checks.push('Cancellation clears the invitation');
}
app.setAppPath(root);
require(join(root, 'dist/main/index.cjs'));
