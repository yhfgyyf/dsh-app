import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DesktopComputerUse } from '../src/main/computer-use.ts';
import { CuaComputerDriver } from '../src/main/computer-use-driver.ts';
import type { ComputerOperation } from '../src/shared/computer-use.ts';

const root = process.env.DSH_COMPUTER_TEST_ROOT!;
const data = join(root, '.test-data/computer-native', String(Date.now()));
app.setName('DSH Computer Fixture');
app.setPath('userData', join(data, 'app-data'));
const report: { checks: string[]; failures: string[]; platform: string; driverPid?: number; windowId?: number } = { checks: [], failures: [], platform: process.platform };
let window: BrowserWindow;
let driver: CuaComputerDriver;
let broker: DesktopComputerUse;
let sequence = 0;
let finishing = false;
app.on('window-all-closed', () => {});
const request = (operation: ComputerOperation, args: Record<string, unknown> = {}) => broker.request({ id: String(++sequence), sessionId: 'native-fixture', operation, arguments: args }, AbortSignal.timeout(60000));
const until = async (check: () => Promise<boolean>, timeout = 5000) => { const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw new Error('Expected native UI effect was not observed.'); await new Promise(resolve => setTimeout(resolve, 100)); } };
const timer = setTimeout(() => { report.failures.push('Native computer test timed out'); void finish(); }, 150000);
async function finish() {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  await broker?.stop().catch(error => report.failures.push(String(error)));
  if (report.driverPid) { let live = true; try { process.kill(report.driverPid, 0); } catch { live = false; } if (live) report.failures.push('Native driver remained after stop'); else report.checks.push('Private driver exited after desktop release'); }
  window?.destroy();
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(root, '.test-data/computer-native-latest.json'), JSON.stringify({ ...report, data }, null, 2));
  console.log(JSON.stringify({ ...report, data }, null, 2));
  app.exit(report.failures.length ? 1 : 0);
}
void app.whenReady().then(async () => {
  await mkdir(data, { recursive: true });
  app.setAccessibilitySupportEnabled(true);
  window = new BrowserWindow({ title: 'DSH Computer Fixture', width: 640, height: 560, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><title>DSH Computer Fixture</title><style>body{font:20px system-ui;padding:30px;background:#fff;color:#222}input,button{font:inherit;padding:12px;margin:12px 0}#scroll{height:100px;overflow:auto;border:2px solid #888}</style></head><body><h1>Computer use fixture</h1><label>Native input <input id="input" aria-label="Native input"></label><br><button id="button" onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1">Native button</button><output id="count">0</output><button id="edge" style="position:fixed;right:24px;bottom:24px;width:56px;height:32px;padding:0;font-size:12px" onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+10">Edge</button><div id="scroll" tabindex="0">${'<p>Scrollable fixture row</p>'.repeat(20)}</div></body></html>`));
  window.show(); window.focus();
  driver = new CuaComputerDriver({ runtimeRoot: join(root, '.runtime'), hostBundleId: 'io.dsh.desktop' });
  broker = new DesktopComputerUse(driver);
  await broker.setEnabled(true, false);
  await request('start', { reason: 'Operate only the isolated native test window', application_pid: process.pid });
  report.driverPid = driver.pid;
  report.checks.push('Electron loaded the pinned native SDK and started a private worker');
  let windows: any;
  await until(async () => { windows = (await request('observe', { kind: 'windows', pid: process.pid })).data; return windows.windows?.some((value: any) => value.title === 'DSH Computer Fixture'); }, 10000);
  const target = windows.windows.find((value: any) => value.title === 'DSH Computer Fixture');
  report.windowId = target.window_id;
  const observe = async () => {
    const result = await request('observe', { kind: 'window', pid: process.pid, window_id: target.window_id });
    await writeFile(join(data, `observation-${sequence}.json`), JSON.stringify(result.data, null, 2));
    if (result.images[0]) await writeFile(join(data, `observation-${sequence}.png`), Buffer.from(result.images[0].dataBase64, 'base64'));
    assert.ok(result.images.length > 0, 'Native screenshot missing');
    return result.data as any;
  };
  let snapshot = await observe();
  assert.ok(snapshot.elements?.length > 0, 'Native accessibility tree missing');
  report.checks.push('Native window enumeration, screenshot and accessibility tree');
  const element = snapshot.elements.find((e: any) => e.label?.includes('Native button'));
  assert.ok(element, 'Fixture button missing from native tree');
  await request('act', { action: 'click', observation_id: snapshot.observation_id, arguments: { element_index: element.element_index } });
  await until(() => window.webContents.executeJavaScript('document.querySelector("#count").textContent === "1"'));
  report.checks.push('Accessibility click delivered a real native event and changed the fixture');
  await assert.rejects(request('act', { action: 'click', observation_id: snapshot.observation_id, arguments: { element_index: element.element_index } }), /观察已失效/);
  snapshot = await observe();
  let x = 0, y = 0;
  const typeText = async (delivery_mode?: string) => {
    const input = snapshot.elements.find((e: any) => e.label?.includes('Native input') && /textfield|textarea|edit|entry/i.test(e.role));
    assert.ok(input, 'Fixture input missing from native tree');
    const bounds = snapshot.window_bounds;
    x = (input.frame.x + input.frame.w / 2 - bounds.x) / bounds.width;
    y = (input.frame.y + input.frame.h / 2 - bounds.y) / bounds.height;
    return request('act', { action: 'type_text', observation_id: snapshot.observation_id, arguments: { x, y, text: 'DSH 你好 123', ...(delivery_mode ? { delivery_mode } : {}) } });
  };
  let typed;
  try { typed = await typeText(); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('background_unavailable:')) throw error;
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#input").value'), '');
    snapshot = await observe();
    typed = await typeText('foreground');
    report.checks.push('Refused background input had no effect; fresh observation permitted explicit foreground input');
  }
  await writeFile(join(data, 'typing.json'), JSON.stringify({ x, y, typed, focused: window.isFocused(), state: await window.webContents.executeJavaScript('({value:document.querySelector("#input").value,active:document.activeElement.id})') }, null, 2));
  snapshot = await observe();
  if (process.platform === 'win32' && await window.webContents.executeJavaScript('document.querySelector("#input").value === ""')) {
    // The driver can restore the previous foreground before Chromium drains
    // SendInput. Retry only after proving zero effect, never after partial input.
    await request('act', { action: 'bring_to_front', observation_id: snapshot.observation_id, arguments: {} });
    await until(async () => window.isFocused());
    snapshot = await observe();
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#input").value'), '', 'Late or partial input must not be appended to blindly');
    typed = await typeText('foreground');
    await writeFile(join(data, 'typing-recovery.json'), JSON.stringify({ typed, focused: window.isFocused() }, null, 2));
    report.checks.push('Verified empty input recovered with an explicit foreground window and a fresh observation');
  }
  await until(() => window.webContents.executeJavaScript('document.querySelector("#input").value === "DSH 你好 123"'));
  report.checks.push('Native Unicode text input verified by independent fixture readback');
  snapshot = await observe();
  const edge = snapshot.elements.find((e: any) => e.label === 'Edge');
  assert.ok(edge, 'Edge calibration target missing');
  await request('act', { action: 'click', observation_id: snapshot.observation_id, arguments: {
    x: (edge.frame.x + edge.frame.w / 2 - snapshot.window_bounds.x) / snapshot.window_bounds.width,
    y: (edge.frame.y + edge.frame.h / 2 - snapshot.window_bounds.y) / snapshot.window_bounds.height,
  } });
  await until(() => window.webContents.executeJavaScript('document.querySelector("#count").textContent === "11"'));
  report.checks.push('Normalized screenshot coordinates hit the narrow bottom-right target');
  await request('stop');
  assert.equal(broker.state.phase, 'idle');
}).catch(error => { report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error)); }).finally(finish);
