const { app, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const root = join(__dirname, '..');
const data = process.env.DSH_BROWSER_SETTINGS_TEST_DATA;
assert.ok(data, 'Run through scripts/test-browser-use-settings.ts');
mkdirSync(data, { recursive: true });
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
const restore = process.env.DSH_BROWSER_SETTINGS_RESTORE === '1';
const report = { restore, checks: [], errors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 240; i++) { if (await check()) return; await sleep(100); }
  throw new Error(message);
}
let finished = false, started = false;
const timer = setTimeout(() => finish(new Error('Browser settings UI timeout')), 60000);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(timer);
  if (error) report.errors.push(String(error.stack ?? error).replace(/token=[^\s&"']+/g, 'token=[redacted]'));
  writeFileSync(join(data, `report-${restore ? 'restore' : 'enable'}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.quit();
}
app.on('quit', () => { if (report.errors.length) process.exit(1); });
app.on('web-contents-created', (_, contents) => contents.on('console-message', details => {
  if (details.level === 'error') { report.errors.push(details.message.replace(/token=[^\s&"']+/g, 'token=[redacted]')); console.error(report.errors.at(-1)); }
}));
const handle = ipcMain.handle.bind(ipcMain);
const handlers = new Map();
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener);
  return handle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'desktop:ready' && !started) {
      started = true;
      setTimeout(() => run(args[0]).then(() => finish()).catch(finish), 100);
    }
    return result;
  });
};
async function run(event) {
  const host = event.sender;
  const js = code => host.executeJavaScript(code, true);
  if (!restore) {
    await until(() => js("Array.from(document.querySelectorAll('button')).some(b=>['继续','Continue'].includes(b.textContent))"), 'Onboarding missing');
    await js("Array.from(document.querySelectorAll('button')).find(b=>['继续','Continue'].includes(b.textContent)).click()");
    // In 0.1.7 the model step may be omitted when a provider is already available.
    await sleep(300);
    await js("Array.from(document.querySelectorAll('button')).find(b=>['稍后配置','Configure later'].includes(b.textContent))?.click()");
  }
  await js("document.querySelector('button.VOzbGW_trigger').click()");
  const selector = '.desktop-browser-use-settings [role="switch"]';
  await until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), 'Browser Use is missing from Settings');
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
  const state = () => js(`(() => { const b=document.querySelector(${JSON.stringify(selector)});return {enabled:b.getAttribute('aria-checked'),busy:b.disabled}; })()`);
  await until(async () => !(await state()).busy, 'Browser switch did not settle');
  assert.equal((await state()).enabled, restore ? 'true' : 'false');
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).closest('[role="dialog"]') !== null`), true);
  assert.equal(await js("document.querySelector('.desktop-titlebar [aria-label=\"浏览器操作\"]') === null"), true);
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).className`), 'desktop-computer-switch');
  report.checks.push(restore ? 'A new app/core process restores the enabled preference' : 'Settings contains Browser Use with the Computer Use switch style and defaults off');
  for (const invalid of [{ ...event, sender: {} }, { ...event, senderFrame: { url: 'https://untrusted.invalid/' } }]) {
    await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:browser-use-enabled')(invalid, true)));
  }
  await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:browser-use-enabled')(event, 'true')));
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await until(async () => !(await state()).busy && (await state()).enabled === (restore ? 'false' : 'true'), 'Browser toggle failed');
  assert.equal(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).browserUseEnabled, !restore);
  const live = await handlers.get('desktop:browser-use-state')(event);
  assert.equal(live.enabled, !restore);
  assert.equal(live.phase, restore ? 'disabled' : 'ready');
  writeFileSync(join(data, `settings-${restore ? 'disabled' : 'enabled'}.png`), (await host.capturePage()).toPNG());
  report.checks.push('Settings toggle reaches the real provider and saves the result; untrusted IPC is rejected');
}
app.setAppPath(root);
require('../dist/main/index.cjs');
