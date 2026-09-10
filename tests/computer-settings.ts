import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './computer-settings-driver.ts';
import { PreferencesFile } from '../src/main/preferences.ts';

const root = process.env.DSH_SETTINGS_TEST_ROOT!;
const data = join(root, '.test-data/computer-settings', String(Date.now()));
mkdirSync(data, { recursive: true });
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
const report = { data, checks: [] as string[], failures: [] as string[] };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<unknown>, label: string) {
  for (let i = 0; i < 160; i++) { if (await check()) return; await sleep(50); }
  throw new Error(label);
}
let finished = false;
const timeout = setTimeout(() => finish(new Error('Settings UI timed out')), 60000);
function finish(error?: unknown) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  if (error) report.failures.push(String(error instanceof Error ? error.stack : error).replace(/token=[^\s&"']+/g, 'token=[redacted]'));
  const json = JSON.stringify(report, null, 2);
  writeFileSync(join(data, 'report.json'), json);
  writeFileSync(join(root, '.test-data/computer-settings-latest.json'), json);
  console.log(json); app.quit();
}
app.on('quit', () => { if (report.failures.length) process.exit(1); });
const original = ipcMain.handle.bind(ipcMain);
const handlers = new Map<string, (...args: any[]) => any>();
const warnings: { detail?: string; buttons?: string[] }[] = [];
let warningResponse: number | undefined;
const openedSettings: string[] = [];
shell.openExternal = async url => { openedSettings.push(url); };
dialog.showMessageBox = (async (...args: any[]) => { const options = args.at(-1); warnings.push(options); const response = warningResponse ?? options.cancelId; warningResponse = undefined; return { response, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
let started = false;
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener);
  return original(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'desktop:ready' && !started) {
      started = true;
      setTimeout(() => { void run(args[0]).then(() => finish()).catch(finish); }, 250);
    }
    return result;
  });
};
async function run(event: IpcMainInvokeEvent) {
  const host = event.sender;
  host.on('console-message', details => { if (details.level === 'error') console.error('Settings fixture renderer:', details.message); });
  const evaluate = (code: string) => host.executeJavaScript(code).catch(error => { throw new Error(code.slice(0, 100) + ': ' + String(error)); });
  const selector = '.desktop-computer [role="switch"]';
  const state = () => evaluate(`(() => { const b=document.querySelector(${JSON.stringify(selector)}); return b && {checked:b.getAttribute('aria-checked'),busy:b.disabled,title:b.title}; })()`);
  const click = () => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const settled = () => until(async () => !(await state())?.busy, 'Switch remained busy');
  await until(async () => !!(await state()), 'Computer switch missing');
  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>['继续','Continue'].includes(b.textContent))?.click()");
  await until(() => evaluate("Array.from(document.querySelectorAll('button')).some(b=>['稍后配置','Configure later'].includes(b.textContent))"), 'Onboarding did not advance');
  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>['稍后配置','Configure later'].includes(b.textContent)).click()");
  await until(() => evaluate("!Array.from(document.querySelectorAll('button')).some(b=>['稍后配置','Configure later'].includes(b.textContent))"), 'Onboarding remained over the switch');
  await evaluate("document.querySelector('.desktop-computer details').open=true");
  assert.equal((await state()).checked, 'false');
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.desktop-computer-controls')).map(n=>({text:n.innerText,paragraphs:n.querySelectorAll('p').length,switches:n.querySelectorAll('[role=switch]').length}))"), [{ text: '电脑操作', paragraphs: 0, switches: 1 }]);
  assert.equal(fixture.starts, 0);
  report.checks.push('Production renderer shows only the computer label and one disabled-state switch');
  // Delay the first write's completion while a real window-state autosave runs.
  const save = PreferencesFile.prototype.save;
  let releaseSave!: () => void;
  let delayed = false;
  let completedWrites = 0;
  PreferencesFile.prototype.save = async function (preferences) {
    await save.call(this, preferences);
    completedWrites++;
    if (!delayed && preferences.computerEnabled) {
      delayed = true;
      await new Promise<void>(resolve => { releaseSave = resolve; });
    }
  };
  await click(); await until(async () => !!releaseSave, 'Preference write was not reached');
  BrowserWindow.fromWebContents(host)!.emit('resize');
  await until(async () => completedWrites > 1, 'Window autosave did not complete'); releaseSave(); await settled();
  PreferencesFile.prototype.save = save;
  assert.equal(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).computerEnabled, true, 'Window autosave overwrote the requested computer preference');
  assert.equal((await state()).checked, 'false'); assert.equal(fixture.prompts, 1);
  assert.match(warnings.at(-1)?.detail ?? '', /辅助功能、屏幕录制/);
  assert.deepEqual(warnings.at(-1)?.buttons, ['打开系统设置', '重置 DSH 旧授权', '关闭']);
  assert.equal(fixture.resets, 0, 'Permissions must never reset automatically');
  fixture.permissions.accessibility = true;
  warningResponse = 1;
  await click(); await settled(); assert.equal((await state()).checked, 'false'); assert.equal(fixture.starts, 0);
  assert.match(warnings.at(-1)?.detail ?? '', /屏幕录制/);
  assert.match(warnings.at(-1)?.detail ?? '', /旧版本的授权/);
  await until(async () => openedSettings.length === 1, 'Explicit reset did not open Settings');
  assert.equal(fixture.resets, 1);
  assert.match(openedSettings[0], /Privacy_Accessibility$/);
  fixture.permissions.screenRecording = true; fixture.fail = true;
  await click(); await settled(); assert.equal((await state()).checked, 'false'); assert.match((await state()).title, /Fixture driver unavailable/);
  assert.match(warnings.at(-1)?.detail ?? '', /Fixture driver unavailable/);
  assert.deepEqual(warnings.at(-1)?.buttons, ['关闭']);
  report.checks.push('Denied permission, partial permission and native-driver failure never light the switch');
  fixture.fail = false;
  let release!: () => void;
  fixture.start = () => new Promise(resolve => { release = resolve; });
  await click(); await until(async () => !!release, 'Driver startup not reached');
  assert.equal((await state()).checked, 'false'); assert.equal((await state()).busy, true);
  release(); await settled(); assert.equal((await state()).checked, 'true'); fixture.start = undefined;
  assert.equal(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).computerEnabled, true);
  writeFileSync(join(data, 'computer-switch.png'), (await host.capturePage()).toPNG());
  await click(); await settled(); assert.equal((await state()).checked, 'false');
  assert.equal(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).computerEnabled, false);
  report.checks.push('Real preload and main IPC wait for successful driver startup; on/off preference is saved');
  fixture.permissions.screenRecording = false;
  await click(); await settled(); assert.equal((await state()).checked, 'false');
  const prompts = fixture.prompts;
  fixture.permissions.screenRecording = true;
  BrowserWindow.fromWebContents(host)!.emit('focus');
  await until(async () => (await state()).checked === 'true', 'Focus did not refresh permission');
  assert.equal(fixture.prompts, prompts);
  await click(); await settled();
  for (const invalid of [{ ...event, sender: {} }, { ...event, senderFrame: { url: 'http://untrusted.invalid/' } }]) await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:computer-enabled')!(invalid, true)));
  await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:computer-enabled')!(event, 'true')));
  await Promise.all([handlers.get('desktop:computer-enabled')!(event, true), handlers.get('desktop:computer-enabled')!(event, false)]);
  assert.equal((await state()).checked, 'false');
  assert.equal(JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8')).computerEnabled, false);
  report.checks.push('Returning from System Settings enables only after permission is granted; foreign IPC is rejected');

  await evaluate(readFileSync(join(root, '.test-data/computer-settings-build/audit.js'), 'utf8'));
  await evaluate(`window.auditFixture=AuditRenderFixture.mount(function(window,fetch,EventSource){${readFileSync(join(root, '.runtime/node_modules/dsh-audit-mode/lib/client.js'), 'utf8')}\n});void 0`);
  const bars = () => evaluate("document.querySelectorAll('#audit-render-fixture [data-audit-bar]').length");
  await sleep(100); assert.equal(await bars(), 0);
  for (const preset of ['audit', 'standard', 'audit', 'code', 'audit', 'minimal', 'audit', 'cordis', 'audit', 'auto']) {
    await evaluate(`auditFixture.select(${JSON.stringify(preset)})`);
    await until(async () => await bars() === (preset === 'audit' ? 1 : 0), 'Audit dock leaked into ' + preset);
  }
  await sleep(100);
  const counts = await evaluate('auditFixture.counts');
  assert.equal(counts.opened, 5); assert.equal(counts.closed, 5);
  await evaluate('auditFixture.dispose()');
  report.checks.push('Actual packaged audit component mounts only in audit mode and closes all five subscriptions when leaving');
}
(app as typeof app & { setAppPath(path: string): void }).setAppPath(root);
void import('../src/main/index.ts');
