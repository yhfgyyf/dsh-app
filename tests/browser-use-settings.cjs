const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
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
  if (restore) BrowserWindow.fromWebContents(host).setContentSize(900, 600);
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
    await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:browser-use-token')(invalid, 'fixture-rejected-extension-token')));
  }
  await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:browser-use-enabled')(event, 'true')));
  await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:browser-use-token')(event, {})));
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await until(async () => !(await state()).busy && (await state()).enabled === (restore ? 'false' : 'true'), 'Browser toggle failed');
  assert.equal(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).browserUseEnabled, !restore);
  const live = await handlers.get('desktop:browser-use-state')(event);
  assert.equal(live.enabled, !restore);
  assert.equal(live.phase, restore ? 'disabled' : 'ready');
  assert.equal(Boolean(live.extensionTokenConfigured), restore);
  assert.equal(Boolean(live.restartRequired), false);
  await js("document.querySelector('.desktop-browser-use-connect').click()");
  await until(() => js("!!document.querySelector('#desktop-browser-use-token')"), 'Credential form missing');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const visibility = await js(`new Promise(resolve => {
    const input = document.querySelector('#desktop-browser-use-token');
    const save = document.querySelector('.desktop-browser-use-credentials button[type=submit]');
    const visible = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) visible.set(entry.target, entry.isIntersecting && entry.intersectionRatio >= 0.99);
      if (visible.size !== 2) return;
      observer.disconnect();
      const rect = input.getBoundingClientRect();
      resolve({ input: visible.get(input), save: visible.get(save), focused: document.activeElement === input,
        inputTop: rect.top, inputBottom: rect.bottom, viewport: { width: innerWidth, height: innerHeight } });
    }, { threshold: 1 });
    observer.observe(input); observer.observe(save);
  })`);
  report.credentialVisibility = visibility;
  writeFileSync(join(data, `credentials-expanded-${restore ? 'restore' : 'enable'}.png`), (await host.capturePage()).toPNG());
  assert.equal(visibility.input, true, 'Opening automatic connection must show the token input inside the scrollable Settings panel');
  assert.equal(visibility.save, true, 'The credential save button must be visible without extra scrolling');
  assert.equal(visibility.focused, true, 'The token input must accept typing immediately after opening');
  report.checks.push('Opening automatic connection brings the token input and save button into view and focuses the input');
  assert.equal(await js("document.querySelector('#desktop-browser-use-token').type"), 'password');
  assert.equal(await js("document.querySelector('#desktop-browser-use-token').value"), '');
  const credentialsPath = join(data, 'browser-use-credentials.json');
  const fixtureToken = 'fixture-browser-auto-connect-token';
  if (!restore) {
    await js(`(() => { const input=document.querySelector('#desktop-browser-use-token');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify('PLAYWRIGHT_MCP_EXTENSION_TOKEN=' + fixtureToken)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await until(() => js("!document.querySelector('.desktop-browser-use-credentials button[type=submit]').disabled"), 'Save did not become available');
    await js("document.querySelector('.desktop-browser-use-credentials').requestSubmit()");
    await until(async () => (await handlers.get('desktop:browser-use-state')(event)).extensionTokenConfigured, 'Credential save failed');
    const stored = readFileSync(credentialsPath, 'utf8');
    assert.ok(!stored.includes(fixtureToken));
    assert.equal(safeStorage.decryptString(Buffer.from(JSON.parse(stored).encryptedToken, 'base64')), fixtureToken);
    assert.ok(!readFileSync(join(data, 'desktop.json'), 'utf8').includes(fixtureToken));
    report.checks.push('Settings saves an explicitly supplied token with native OS encryption; preferences and IPC state contain no plaintext token');
  } else {
    await js("Array.from(document.querySelectorAll('.desktop-browser-use-credentials button')).find(b=>b.textContent==='清除令牌').click()");
    await until(async () => !(await handlers.get('desktop:browser-use-state')(event)).extensionTokenConfigured, 'Credential clear failed');
    assert.equal(existsSync(credentialsPath), false);
    report.checks.push('A cold restart decrypts the credential without returning it to the renderer; clearing removes the encrypted file');
  }
  const saved = await handlers.get('desktop:browser-use-state')(event);
  assert.equal(saved.restartRequired, true);
  assert.ok(!JSON.stringify(saved).includes(fixtureToken));
  await until(() => js("!document.querySelector('#desktop-browser-use-token')"), 'Credential form did not clear after saving');
  writeFileSync(join(data, `settings-${restore ? 'disabled' : 'enabled'}.png`), (await host.capturePage()).toPNG());
  report.checks.push('Settings toggle reaches the real provider and saves the result; untrusted IPC is rejected');
}
app.setAppPath(root);
require('../dist/main/index.cjs');
