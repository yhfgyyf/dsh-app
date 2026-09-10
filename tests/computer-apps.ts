import { app, BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CuaComputerDriver } from '../src/main/computer-use-driver.ts';
import { DesktopComputerUse } from '../src/main/computer-use.ts';
import { ComputerPreviewWindow } from '../src/main/computer-preview.ts';
import type { ComputerAction, ComputerOperation } from '../src/shared/computer-use.ts';

const root = process.env.DSH_COMPUTER_TEST_ROOT!;
const pointerOnly = process.env.DSH_COMPUTER_APPS_POINTER_ONLY === '1';
const data = join(root, '.test-data/computer-apps', String(Date.now()));
const execute = promisify(execFile);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Snapshot = {
  observation_id: string; pid: number; window_id: number; window_bounds: Rect;
  screenshot_dimensions: { width: number; height: number };
  elements?: { element_index: number; role: string; label?: string; frame?: { x: number; y: number; w: number; h: number } }[];
};
type BlenderState = {
  pid: number; time: number; filepath: string; objects: string[];
  counts: Record<string, number>; texts: { name: string; content: string }[];
  pointer_command?: { id: string; window_point?: Point; error?: string };
  areas: { type: string; regions: (Rect & { type: string; targets?: Record<string, [number, number, number, number]> })[] }[];
};
const report: {
  data: string; checks: string[]; failures: string[]; scope: string;
  apps: { name: string; pid: number; windowId?: number }[];
  existing: Record<string, number[]>; workerPids: number[];
  blenderPointer?: { timelineExpected: Point; editorExpected: Point; samples: { phase: string; time: number; point: Point }[] };
} = {
  data, checks: [], failures: [], apps: [], existing: {}, workerPids: [],
  scope: 'Deterministic native delivery regression through the real DSH broker and driver. Fixture geometry supplies click targets; this does not measure model visual localization or task planning.',
};
let driver: CuaComputerDriver;
let broker: DesktopComputerUse;
let preview: ComputerPreviewWindow;
let focusProbe: BrowserWindow | undefined;
let sequence = 0;
let finishing = false;
let target: { pid: number; windowId: number };
let observation: Snapshot;
const owned = new Set<number>();
app.setName('DSH Computer Apps Fixture');
app.setPath('userData', join(data, 'electron-data'));
app.on('window-all-closed', () => {});

async function until(check: () => Promise<boolean>, message: string, timeout = 10000) {
  const start = Date.now();
  while (!await check()) {
    if (finishing || Date.now() - start >= timeout) throw new Error(message);
    await wait(100);
  }
}
async function pids(name: string): Promise<number[]> {
  try { return (await execute('/usr/bin/pgrep', ['-x', name], { timeout: 5000 })).stdout.trim().split('\n').filter(Boolean).map(Number); }
  catch (error) { if ((error as { code?: number }).code === 1) return []; throw error; }
}
function running(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function request(name: string, operation: ComputerOperation, args: Record<string, unknown> = {}) {
  if (finishing) throw new Error('Native app fixture is stopping');
  const id = String(++sequence);
  const entry = { id, name, operation, arguments: args };
  await appendFile(join(data, 'requests.jsonl'), JSON.stringify({ ...entry, phase: 'start' }) + '\n');
  try {
    const result = await broker.request({ id, sessionId: 'computer-apps-fixture', operation, arguments: args }, AbortSignal.timeout(60000));
    if (result.images[0]) await writeFile(join(data, `${id}-${name}.png`), Buffer.from(result.images[0].dataBase64, 'base64'));
    await writeFile(join(data, `${id}-${name}.json`), JSON.stringify({ ...entry, text: result.text, data: result.data }, null, 2));
    if ((result.data as Snapshot | undefined)?.observation_id) observation = result.data as Snapshot;
    await appendFile(join(data, 'requests.jsonl'), JSON.stringify({ id, phase: 'end' }) + '\n');
    return result;
  } catch (error) {
    await appendFile(join(data, 'requests.jsonl'), JSON.stringify({ id, phase: 'error', error: String(error) }) + '\n');
    throw error;
  }
}
const observe = (name: string, maxDimension = 1400) => request(name, 'observe', { kind: 'window', pid: target.pid, window_id: target.windowId, max_dimension: maxDimension });
const act = (name: string, action: ComputerAction, args: Record<string, unknown> = {}) => request(name, 'act', { action, observation_id: observation.observation_id, arguments: { ...(!['bring_to_front', 'invoke_menu', 'set_value', 'launch_app'].includes(action) ? { delivery_mode: 'foreground' } : {}), ...args } });

async function startApp(name: string, pid: number, title?: string) {
  assert.ok(owned.has(pid), 'Refusing to target an application not started by this fixture');
  await broker.setEnabled(true, false);
  assert.ok(broker.state.enabled, broker.state.error || 'Native permissions are unavailable');
  await request(`${name}-start`, 'start', { reason: `Operate only the newly started ${name} test process and disposable document`, application_pid: pid });
  let found: { pid: number; window_id: number } | undefined;
  await until(async () => {
    const result = await request(`${name}-windows`, 'observe', { kind: 'windows', pid });
    const windows = (result.data as { windows?: { pid: number; window_id: number; title: string; is_on_screen?: boolean; bounds?: Rect }[] }).windows || [];
    found = windows.find(window => window.pid === pid && window.is_on_screen === true && (window.bounds?.width || 0) > 300 && !!window.title && (!title || window.title.includes(title)));
    return !!found;
  }, `${name} did not expose the expected independent document window`, 20000);
  target = { pid, windowId: found!.window_id };
  report.apps.push({ name, pid, windowId: target.windowId });
  await observe(`${name}-initial`);
  await act(`${name}-foreground`, 'bring_to_front', {});
}
async function previewInterleave() {
  const before = observation.observation_id;
  await preview.show();
  const picture = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'DSH 电脑操作');
  assert.ok(picture && !picture.isFocusable(), 'PiP must not take keyboard focus');
  for (let index = 0; index < 3; index++) assert.ok((await broker.preview())?.image, 'PiP native capture is missing');
  assert.equal(observation.observation_id, before);
  assert.ok(driver.previewPid && driver.previewPid !== driver.pid, 'PiP must use a separate worker');
}
async function release() {
  const workers = [driver?.pid, driver?.previewPid].filter((pid): pid is number => !!pid);
  report.workerPids.push(...workers);
  await broker?.stop();
  for (const pid of workers) assert.equal(running(pid), false, `Native worker ${pid} survived release`);
}
async function stopOwned(pid: number) {
  if (!owned.has(pid)) throw new Error('Refusing to stop an application not started by this fixture');
  if (running(pid)) process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (running(pid) && Date.now() < deadline) await wait(100);
  if (running(pid)) { process.kill(pid, 'SIGKILL'); await wait(100); }
  assert.equal(running(pid), false, `Fixture process ${pid} did not exit`);
  owned.delete(pid);
}
const blenderState = async () => JSON.parse(await readFile(join(data, 'blender-state.json'), 'utf8')) as BlenderState;
async function assertBlender(name: string, check: (state: BlenderState) => boolean) {
  await until(async () => check(await blenderState()), `Blender readback failed: ${name}`);
  await writeFile(join(data, `${name}-readback.json`), JSON.stringify(await blenderState(), null, 2));
  report.checks.push(name);
}
function blenderPoint(x: number, y: number) {
  // Blender's region oracle reports bottom-origin backing pixels. Convert its
  // known test geometry into the complete screenshot's normalized coordinates;
  // the driver under test still performs its own screenshot-to-window mapping.
  const bounds = observation.window_bounds;
  const scale = screen.getDisplayMatching(bounds).scaleFactor;
  return { x: x / scale / bounds.width, y: 1 - y / scale / bounds.height };
}
function screenPoint(point: Point): Point {
  const bounds = observation.window_bounds;
  return { x: bounds.x + point.x * bounds.width, y: bounds.y + point.y * bounds.height };
}
function nearPoint(actual: Point, expected: Point) { return Math.hypot(actual.x - expected.x, actual.y - expected.y) <= 2; }
async function recordBlenderPointer(phase: string) {
  assert.ok(report.blenderPointer);
  const point = screen.getCursorScreenPoint();
  report.blenderPointer.samples.push({ phase, time: Date.now(), point });
  await writeFile(join(data, 'blender-pointer-readback.json'), JSON.stringify(report.blenderPointer, null, 2));
  return point;
}
async function parkBlenderPointer(editor: Point) {
  assert.ok(owned.has(target.pid), 'Only the fixture-owned Blender may reposition the physical pointer');
  // Blender's cursor_warp requires an active Cocoa window. Prior PiP checks
  // restore the previous foreground app, so establish this fixture precondition
  // without clicking or changing the editor selection under test.
  await act('blender-pointer-setup-foreground', 'bring_to_front', {});
  const command = { id: String(Date.now()), pid: target.pid, action: 'park_timeline' };
  const commandPath = join(data, 'blender-pointer-command.json');
  await writeFile(`${commandPath}.tmp`, JSON.stringify(command));
  await rename(`${commandPath}.tmp`, commandPath);
  let result: BlenderState['pointer_command'];
  await until(async () => {
    const state = await blenderState();
    assert.equal(state.pid, target.pid);
    result = state.pointer_command;
    if (result?.id !== command.id) return false;
    assert.equal(result.error, undefined, `Blender cursor setup failed: ${result.error}`);
    return !!result.window_point;
  }, 'The fixture-owned Blender did not acknowledge pointer setup');
  const timeline = screenPoint(blenderPoint(result!.window_point!.x, result!.window_point!.y));
  report.blenderPointer = { timelineExpected: timeline, editorExpected: screenPoint(editor), samples: [] };
  await recordBlenderPointer('timeline-command-acknowledged');
  try {
    await until(async () => nearPoint(screen.getCursorScreenPoint(), timeline), 'Blender pointer setup did not reach the expected physical screen coordinates');
  } finally {
    await recordBlenderPointer('timeline-setup-finished');
  }
  await recordBlenderPointer('timeline-setup-confirmed');
}
async function focusFixtureWindow(pointer: Point) {
  focusProbe = new BrowserWindow({ title: 'DSH Input Focus Fixture', x: 20, y: 20, width: 320, height: 100, show: false, webPreferences: { sandbox: true } });
  focusProbe.show();
  focusProbe.focus();
  await until(async () => focusProbe?.isFocused() === true, 'The test-owned focus window did not become active');
  const actual = await recordBlenderPointer('after-fixture-window-focus');
  assert.ok(nearPoint(actual, pointer), 'The physical pointer moved while the fixture changed window focus');
}
function closeFocusProbe() {
  if (focusProbe && !focusProbe.isDestroyed()) focusProbe.destroy();
  focusProbe = undefined;
}
async function testBlender() {
  const executable = process.env.DSH_BLENDER_TEST_EXECUTABLE || '/Applications/Blender.app/Contents/MacOS/Blender';
  const child = spawn(executable, ['--factory-startup', '--window-geometry', '100', '100', '1100', '740', '--python', join(root, 'tests/fixtures/computer-apps-blender.py')], {
    env: { ...process.env, DSH_BLENDER_TEST_STATE: join(data, 'blender-state.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let launchError: Error | undefined;
  child.once('error', error => { launchError = error; });
  if (child.pid) owned.add(child.pid);
  child.stdout?.on('data', chunk => { void appendFile(join(data, 'blender.log'), chunk); });
  child.stderr?.on('data', chunk => { void appendFile(join(data, 'blender.log'), chunk); });
  await until(async () => {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Blender exited during startup: ${child.exitCode}`);
    try { return (await blenderState()).pid === child.pid; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }, 'Blender independent observer did not start', 30000);
  await startApp('blender', child.pid!);
  assert.equal((await blenderState()).filepath, '', 'Fixture must not open an existing Blender document');
  for (const dimension of pointerOnly ? [] : [1400, 320, 1600]) {
    await observe(`blender-targets-${dimension}`, dimension);
    assert.ok(Math.max(observation.screenshot_dimensions.width, observation.screenshot_dimensions.height) <= dimension);
    for (const name of ['left', 'right']) {
      const state = await blenderState();
      const region = state.areas.find(area => area.type === 'TEXT_EDITOR')!.regions.find(value => value.type === 'WINDOW')!;
      const [x, y, width, height] = region.targets![name];
      await previewInterleave();
      await act(`blender-${name}-${dimension}`, 'click', blenderPoint(x + width / 2, y + height / 2));
      await assertBlender(`Blender ${dimension}px ${name} small target after PiP`, next => next.counts[name] === state.counts[name] + 1);
    }
  }
  const region = (await blenderState()).areas.find(area => area.type === 'TEXT_EDITOR')!.regions.find(value => value.type === 'WINDOW')!;
  const editor = blenderPoint(region.x + region.width * 0.4, region.y + region.height * 0.6);
  await parkBlenderPointer(editor);
  await recordBlenderPointer('before-editor-click');
  await act('blender-editor-focus', 'click', editor);
  const afterClick = await recordBlenderPointer('after-editor-click');
  // Activate only this test's own window, without clicking or moving the
  // pointer, so paste must re-activate Blender and retain its editor context.
  await focusFixtureWindow(afterClick);
  const first = '# DSH 原生输入测试\n# 中文第二行 123\n';
  await recordBlenderPointer('before-paste');
  await act('blender-paste-chinese', 'type_text', { method: 'paste', text: first });
  await recordBlenderPointer('after-paste');
  await assertBlender('Blender exact Chinese multiline paste', state => state.texts.find(text => text.name === 'DSH Computer Fixture')?.content === first);
  assert.ok(nearPoint(afterClick, report.blenderPointer!.editorExpected), 'Foreground editor click did not persist the physical pointer at its target');
  report.checks.push('Blender foreground click moves the physical pointer from timeline to editor before keyboard input');
  await act('blender-select-all', 'hotkey', { keys: ['cmd', 'a'] });
  const script = '# DSH 全选替换验证\nimport bpy\nobj = bpy.data.objects.new("DSH_COMPUTER_VERIFIED", None)\nbpy.context.scene.collection.objects.link(obj)\n';
  // No second focus click: it would destroy the selection we just made.
  await act('blender-replace-selection', 'type_text', { method: 'paste', text: script });
  await assertBlender('Blender select-all replaces exactly without appending', state => state.texts.find(text => text.name === 'DSH Computer Fixture')?.content === script);
  await act('blender-run-text', 'hotkey', { keys: ['alt', 'p'] });
  await assertBlender('Blender foreground Run Script creates the expected object', state => state.objects.filter(name => name === 'DSH_COMPUTER_VERIFIED').length === 1);
  await release();
  await stopOwned(child.pid!);
}
async function testTextEdit() {
  const filename = `dsh-computer-${Date.now()}.txt`;
  const file = join(data, filename);
  await writeFile(file, 'DSH fixture seed\n');
  const before = await pids('TextEdit');
  // -n starts a separate process; -F suppresses restoration of old documents.
  await execute('/usr/bin/open', ['-n', '-F', '-a', '/System/Applications/TextEdit.app', file], { timeout: 15000 });
  let pid: number | undefined;
  await until(async () => {
    const added = (await pids('TextEdit')).filter(value => !before.includes(value));
    assert.ok(added.length <= 1, 'Ambiguous TextEdit process ownership; refusing to operate');
    pid = added[0];
    return !!pid;
  }, 'TextEdit did not start a new independent process', 15000);
  owned.add(pid!);
  await startApp('textedit', pid!, filename);
  const input = observation.elements?.find(element => /textarea|textfield/i.test(element.role) && element.frame && element.frame.w > 200 && element.frame.h > 80);
  assert.ok(input?.frame, 'The independent TextEdit document has no native editable text area');
  const bounds = observation.window_bounds;
  const point = { x: (input.frame.x + input.frame.w * 0.4 - bounds.x) / bounds.width, y: (input.frame.y + input.frame.h * 0.4 - bounds.y) / bounds.height };
  await act('textedit-focus', 'click', point);
  await act('textedit-select-seed', 'hotkey', { keys: ['cmd', 'a'] });
  const first = 'DSH 原生跨应用测试\n中文第二行 123\n';
  const field = observation.elements?.find(element => /textarea|textfield/i.test(element.role) && element.frame && element.frame.w > 200 && element.frame.h > 80);
  assert.ok(field, 'The current observation must contain the editable TextEdit field');
  await act('textedit-keyboard-chinese', 'type_text', { element_index: field.element_index, text: first });
  await act('textedit-save-first', 'hotkey', { keys: ['cmd', 's'] });
  await until(async () => await readFile(file, 'utf8') === first, 'TextEdit keyboard input did not save the exact Chinese multiline text');
  report.checks.push('TextEdit observed AX text input verified from the saved UTF-8 file');
  await observe('textedit-small-320', 320);
  await previewInterleave();
  await act('textedit-focus-small', 'click', point);
  await act('textedit-select-all', 'hotkey', { keys: ['cmd', 'a'] });
  const replacement = 'DSH 替换完成\n第二行保留中文\n';
  await act('textedit-paste-replacement', 'type_text', { method: 'paste', text: replacement });
  await act('textedit-save-replacement', 'hotkey', { keys: ['cmd', 's'] });
  await until(async () => await readFile(file, 'utf8') === replacement, 'TextEdit replacement was not saved exactly');
  report.checks.push('TextEdit select-all and Chinese multiline paste preserve selection after 320px observation and PiP');
  await release();
  await stopOwned(pid!);
}

const timer = setTimeout(() => { report.failures.push('Native app tests exceeded the eight-minute deadline'); void finish(); }, 8 * 60000);
async function finish() {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  try { await release(); } catch (error) { report.failures.push(`Release: ${String(error)}`); }
  preview?.dispose();
  closeFocusProbe();
  for (const pid of [...owned]) {
    try { await stopOwned(pid); } catch (error) { report.failures.push(`Cleanup: ${String(error)}`); }
  }
  for (const [name, existing] of Object.entries(report.existing)) {
    const alive = await pids(name).catch((): number[] => []);
    for (const pid of existing) if (!alive.includes(pid)) report.failures.push(`Pre-existing ${name} process ${pid} is no longer running`);
  }
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(root, '.test-data/computer-apps-latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.failures.length ? 1 : 0);
}
void app.whenReady().then(async () => {
  await mkdir(data, { recursive: true });
  if (process.platform !== 'darwin') throw new Error('This application fixture requires macOS');
  report.existing = { Blender: await pids('Blender'), TextEdit: await pids('TextEdit') };
  driver = new CuaComputerDriver({ runtimeRoot: join(root, '.runtime'), hostBundleId: process.env.DSH_COMPUTER_TEST_HOST_BUNDLE_ID || 'io.dsh.desktop' });
  const permissions = await driver.permissions(false);
  assert.ok(permissions.accessibility && permissions.screenRecording, 'The current test host requires existing Accessibility and Screen Recording permissions; no apps were opened');
  broker = new DesktopComputerUse(driver, state => preview?.update(state));
  preview = new ComputerPreviewWindow(broker, process.env.DSH_COMPUTER_PREVIEW_ROOT!, () => {});
  for (const test of pointerOnly ? [testBlender] : [testBlender, testTextEdit]) {
    if (finishing) break;
    try { await test(); }
    catch (error) { report.failures.push(`${test.name}: ${error instanceof Error ? error.stack || error.message : String(error)}`); }
    finally {
      await release().catch(error => report.failures.push(String(error)));
      closeFocusProbe();
      for (const pid of [...owned]) await stopOwned(pid).catch(error => report.failures.push(String(error)));
    }
  }
}).catch(error => report.failures.push(error instanceof Error ? error.stack || error.message : String(error))).finally(finish);
