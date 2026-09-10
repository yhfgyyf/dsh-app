import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DesktopComputerUse } from '../src/main/computer-use.ts';
import { CuaComputerDriver } from '../src/main/computer-use-driver.ts';
import { ComputerPreviewWindow } from '../src/main/computer-preview.ts';
import type { ComputerOperation } from '../src/shared/computer-use.ts';

const root = process.env.DSH_COMPUTER_TEST_ROOT!;
const data = join(root, '.test-data/computer-native', String(Date.now()));
app.setName('DSH Computer Fixture');
app.setPath('userData', join(data, 'app-data'));
const report: { checks: string[]; failures: string[]; platform: string; driverPid?: number; previewPid?: number; windowId?: number } = { checks: [], failures: [], platform: process.platform };
let window: BrowserWindow;
let driver: CuaComputerDriver;
let broker: DesktopComputerUse;
let preview: ComputerPreviewWindow;
let focusProbe: BrowserWindow | undefined;
let sequence = 0;
let finishing = false;
app.on('window-all-closed', () => {});
const request = async (operation: ComputerOperation, args: Record<string, unknown> = {}) => {
  const id = String(++sequence);
  await appendFile(join(data, 'requests.jsonl'), JSON.stringify({ id, operation, args, phase: 'start' }) + '\n');
  try { return await broker.request({ id, sessionId: 'native-fixture', operation, arguments: args }, AbortSignal.timeout(60000)); }
  finally { await appendFile(join(data, 'requests.jsonl'), JSON.stringify({ id, phase: 'end' }) + '\n'); }
};
const until = async (check: () => Promise<boolean>, timeout = 5000) => { const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw new Error('Expected native UI effect was not observed.'); await new Promise(resolve => setTimeout(resolve, 100)); } };
const timer = setTimeout(() => { report.failures.push('Native computer test timed out'); void finish(); }, 180000);
async function finish() {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2));
  await broker?.stop().catch(error => report.failures.push(String(error)));
  preview?.dispose();
  if (report.driverPid) { let live = true; try { process.kill(report.driverPid, 0); } catch { live = false; } if (live) report.failures.push('Native driver remained after stop'); else report.checks.push('Private driver exited after desktop release'); }
  if (report.previewPid) { let live = true; try { process.kill(report.previewPid, 0); } catch { live = false; } if (live) report.failures.push('Preview driver remained after stop'); else report.checks.push('Private preview driver exited after desktop release'); }
  focusProbe?.destroy();
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
  // The fixture must keep painting visual changes even when other windows cover it.
  window = new BrowserWindow({ title: 'DSH Computer Fixture', width: 640, height: 560, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><title>DSH Computer Fixture</title><style>body{font:20px system-ui;padding:30px;background:#fff;color:#222}input,button{font:inherit;padding:12px;margin:12px 0}#scroll{height:100px;overflow:auto;border:2px solid #888}</style></head><body><h1>Computer use fixture</h1><label>Native input <input id="input" aria-label="Native input"></label><br><button id="button" onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1">Native button</button><output id="count">0</output><button id="edge" style="position:fixed;right:24px;bottom:24px;width:56px;height:32px;padding:0;font-size:12px" onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+10">Edge</button><div id="scroll" tabindex="0">${'<p>Scrollable fixture row</p>'.repeat(20)}</div><input id="slider" aria-label="Native slider" type="range" min="0" max="100" value="0" style="position:fixed;left:40px;bottom:12px;width:240px;height:24px;padding:0;margin:0" onpointermove="if(event.isTrusted&amp;&amp;event.buttons===1)window.fixtureDragMoves=(window.fixtureDragMoves||0)+1" oninput="document.querySelector('#slider-value').textContent=this.value"><output id="slider-value" style="position:fixed;left:296px;bottom:12px">0</output></body></html>`));
  await window.webContents.executeJavaScript(`
    window.fixtureKeys = [];
    window.fixtureInputEvents = [];
    window.fixtureCaptureKeys = false;
    window.fixtureTraceTyping = false;
    document.addEventListener('keydown', event => {
      window.fixtureKeys.push({ key: event.key, code: event.code, trusted: event.isTrusted,
        meta: event.metaKey, alt: event.altKey, ctrl: event.ctrlKey, shift: event.shiftKey,
        target: event.target.id, focused: document.hasFocus() });
      if (window.fixtureCaptureKeys && event.code === 'KeyK') event.preventDefault();
    }, true);
    document.addEventListener('input', event => {
      if (window.fixtureTraceTyping) window.fixtureInputEvents.push({ trusted: event.isTrusted,
        target: event.target.id, value: event.target.value });
    }, true);
  `);
  window.show(); window.focus();
  driver = new CuaComputerDriver({ runtimeRoot: join(root, '.runtime'), hostBundleId: 'io.dsh.desktop' });
  broker = new DesktopComputerUse(driver, state => preview?.update(state));
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => { handlers.set(channel, listener); handle(channel, listener); };
  preview = new ComputerPreviewWindow(broker, root, () => { window.show(); window.focus(); });
  ipcMain.handle = handle;
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
  let previewWindow: BrowserWindow | undefined;
  await until(async () => { previewWindow = BrowserWindow.getAllWindows().find(value => value !== window && value.getTitle() === 'DSH 电脑操作'); return !!previewWindow?.isVisible(); });
  assert.equal(previewWindow!.isFocusable(), false, 'Picture-in-picture can steal keyboard focus');
  assert.equal(previewWindow!.isFocused(), false, 'Picture-in-picture stole keyboard focus');
  await until(async () => !!await previewWindow!.webContents.executeJavaScript('document.querySelector("img")?.naturalWidth'));
  report.previewPid = driver.previewPid;
  assert.ok(report.previewPid && report.previewPid !== report.driverPid, 'PiP must capture in a separate native worker');
  assert.equal(await previewWindow!.webContents.executeJavaScript('typeof window.dshDesktop'), 'undefined');
  const previewEvent = { sender: previewWindow!.webContents, senderFrame: previewWindow!.webContents.mainFrame } as IpcMainInvokeEvent;
  for (const command of ['state', 'frame', 'stop', 'return', 'hide']) {
    for (const invalid of [{ ...previewEvent, sender: window.webContents }, { ...previewEvent, senderFrame: { url: 'https://untrusted.invalid/' } }]) await assert.rejects(Promise.resolve().then(() => handlers.get(`computer-preview:${command}`)!(invalid as IpcMainInvokeEvent)));
  }
  report.checks.push('PiP has only read/stop/return/hide IPC; all commands reject foreign windows and frames');
  await writeFile(join(data, 'picture-in-picture.png'), (await previewWindow!.webContents.capturePage()).toPNG());
  const firstFrame = await previewWindow!.webContents.executeJavaScript('document.querySelector("img").src');
  const imageHash = (base64?: string) => base64 ? createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') : undefined;
  const polling: {
    captureCalls: number; previewCalls: number;
    lastCapture?: { startedAt: number; completedAt?: number; imageSha256?: string; error?: string };
    lastPreview?: { returnedAt: number; capturedAt?: number; imageSha256?: string; error?: string };
  } = { captureCalls: 0, previewCalls: 0 };
  const capturePreview = driver.capturePreview.bind(driver), readPreview = broker.preview.bind(broker);
  driver.capturePreview = async (args, signal) => {
    polling.captureCalls++;
    const capture: NonNullable<typeof polling.lastCapture> = { startedAt: Date.now() };
    polling.lastCapture = capture;
    try {
      const result = await capturePreview(args, signal);
      capture.imageSha256 = imageHash(result.images[0]?.dataBase64);
      return result;
    } catch (error) { capture.error = String(error); throw error; }
    finally { capture.completedAt = Date.now(); }
  };
  broker.preview = async () => {
    polling.previewCalls++;
    try {
      const result = await readPreview();
      polling.lastPreview = { returnedAt: Date.now(), capturedAt: result?.capturedAt, imageSha256: imageHash(result?.image?.dataBase64), error: result?.error };
      return result;
    } catch (error) { polling.lastPreview = { returnedAt: Date.now(), error: String(error) }; throw error; }
  };
  const updateStartedAt = Date.now();
  let updatePassed = false;
  try {
    await window.webContents.executeJavaScript('document.body.style.background="#ddeeff"');
    await until(async () => await previewWindow!.webContents.executeJavaScript(`(() => { const image = document.querySelector("img"); return !!image && image.naturalWidth > 0 && image.src !== ${JSON.stringify(firstFrame)}; })()`), 10000);
    updatePassed = true;
  } finally {
    driver.capturePreview = capturePreview; broker.preview = readPreview;
    const capturedPolling = structuredClone(polling);
    const targetState = await window.webContents.executeJavaScript('({computedBackground:getComputedStyle(document.body).backgroundColor,hidden:document.hidden,visibilityState:document.visibilityState,focused:document.hasFocus()})');
    const { imageSrc, ...previewState } = await previewWindow!.webContents.executeJavaScript('({hidden:document.hidden,visibilityState:document.visibilityState,focused:document.hasFocus(),status:document.querySelector(".status")?.textContent,imageSrc:document.querySelector("img")?.src,imageWidth:document.querySelector("img")?.naturalWidth,text:document.querySelector(".screen")?.textContent})');
    await writeFile(join(data, 'picture-in-picture-update.json'), JSON.stringify({
      passed: updatePassed, timeoutMs: 10000, startedAt: updateStartedAt, recordedAt: Date.now(),
      initialFrameSha256: imageHash(firstFrame.split(',')[1]), polling: capturedPolling,
      target: { ...targetState, visible: window.isVisible(), focusedWindow: window.isFocused() },
      preview: { ...previewState, visible: previewWindow!.isVisible(), focusedWindow: previewWindow!.isFocused(), imageSha256: imageHash(imageSrc?.split(',')[1]) },
    }, null, 2));
    if (!updatePassed) {
      await writeFile(join(data, 'picture-in-picture-timeout-target.png'), (await window.webContents.capturePage()).toPNG());
      await writeFile(join(data, 'picture-in-picture-timeout-preview.png'), (await previewWindow!.webContents.capturePage()).toPNG());
    }
  }
  const clicked = await request('act', { action: 'click', observation_id: snapshot.observation_id, arguments: { element_index: element.element_index } });
  assert.ok(clicked.images.length, 'Real action did not return a verification screenshot');
  assert.notEqual((clicked.data as any).observation_id, snapshot.observation_id);
  await until(() => window.webContents.executeJavaScript('document.querySelector("#count").textContent === "1"'));
  report.checks.push('Accessibility click delivered a real native event and changed the fixture');
  report.checks.push('Live picture-in-picture updates without stealing focus or invalidating native AX snapshots; action returns fresh screenshot');
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
    if (!(error instanceof Error) || !error.message.includes('background_unavailable:')) throw error;
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#input").value'), '');
    snapshot = await observe();
    // Establish a stable foreground before SendInput; background delivery may
    // have restored a runner console (or HWND 0) after its refused click.
    if (process.platform === 'win32') {
      await request('act', { action: 'bring_to_front', observation_id: snapshot.observation_id, arguments: {} });
      await until(async () => window.isFocused());
      snapshot = await observe();
      assert.equal(await window.webContents.executeJavaScript('document.querySelector("#input").value'), '');
    }
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
  for (let i = 0; i < 3; i++) assert.ok((await broker.preview())?.image, 'Live capture missing');
  await request('act', { action: 'click', observation_id: snapshot.observation_id, arguments: {
    x: (edge.frame.x + edge.frame.w / 2 - snapshot.window_bounds.x) / snapshot.window_bounds.width,
    y: (edge.frame.y + edge.frame.h / 2 - snapshot.window_bounds.y) / snapshot.window_bounds.height,
  } });
  await until(() => window.webContents.executeJavaScript('document.querySelector("#count").textContent === "11"'));
  report.checks.push('Normalized screenshot coordinates hit the narrow bottom-right target');
  const observedSmall = await request('observe', { kind: 'window', pid: process.pid, window_id: target.window_id, max_dimension: 320 });
  const small = observedSmall.data as any;
  assert.ok(small.screenshot_dimensions.width <= 320 && small.screenshot_dimensions.height <= 320);
  const smallEdge = small.elements.find((e: any) => e.label === 'Edge');
  for (let i = 0; i < 3; i++) assert.ok((await broker.preview())?.image);
  await request('act', { action: 'click', observation_id: small.observation_id, arguments: {
    x: (smallEdge.frame.x + smallEdge.frame.w / 2 - small.window_bounds.x) / small.window_bounds.width,
    y: (smallEdge.frame.y + smallEdge.frame.h / 2 - small.window_bounds.y) / small.window_bounds.height,
  } });
  await until(() => window.webContents.executeJavaScript('document.querySelector("#count").textContent === "21"'));
  report.checks.push('Resized 320px observations retain correct edge coordinates after repeated PiP captures');
  snapshot = await observe();
  const beforeMove = window.getBounds();
  const staleEdge = snapshot.elements.find((e: any) => e.label === 'Edge');
  const stalePoint = {
    x: (staleEdge.frame.x + staleEdge.frame.w / 2 - snapshot.window_bounds.x) / snapshot.window_bounds.width,
    y: (staleEdge.frame.y + staleEdge.frame.h / 2 - snapshot.window_bounds.y) / snapshot.window_bounds.height,
  };
  const requestedBounds = { x: beforeMove.x + 24, y: beforeMove.y + 20, width: beforeMove.width + 80, height: beforeMove.height + 40 };
  const nativeBounds: Record<string, unknown>[] = [];
  const geometry: Record<string, unknown> = { observationId: snapshot.observation_id, observedBounds: snapshot.window_bounds, beforeMove, requestedBounds, stalePoint, nativeBounds };
  let geometryStage = 'before-move';
  const callDriver = driver.call.bind(driver);
  driver.call = async (name, args, signal) => {
    const result = await callDriver(name, args, signal);
    if (name === 'list_windows' && args.pid === process.pid) {
      const values = Array.isArray(result.data) ? result.data : (result.data as any)?.windows;
      const current = values?.find((value: any) => value.pid === process.pid && value.window_id === target.window_id);
      nativeBounds.push({ stage: geometryStage, at: Date.now(), pid: current?.pid, windowId: current?.window_id, bounds: current?.bounds });
    }
    return result;
  };
  const saveGeometry = () => writeFile(join(data, 'window-geometry.json'), JSON.stringify(geometry, null, 2));
  try {
    await driver.call('list_windows', { pid: process.pid }, AbortSignal.timeout(5000));
    await saveGeometry();
    window.setBounds(requestedBounds);
    await until(async () => window.getBounds().width === requestedBounds.width && window.getBounds().height === requestedBounds.height);
    geometry.afterSetBounds = window.getBounds();
    geometryStage = 'after-setBounds';
    await driver.call('list_windows', { pid: process.pid }, AbortSignal.timeout(5000));
    await saveGeometry();
    // Electron can report new bounds before the OS window list commits them.
    // Establish that native move/resize first, without replacing the old observation.
    geometryStage = 'native-move-wait';
    const nativeMoveStartedAt = Date.now();
    await until(async () => {
      await driver.call('list_windows', { pid: process.pid }, AbortSignal.timeout(5000));
      const current = nativeBounds.at(-1)?.bounds as Record<string, number> | undefined;
      return !!current && ['x', 'y', 'width', 'height'].every(key => current[key] !== snapshot.window_bounds[key]);
    }, 5000);
    geometry.nativeMoveWaitMs = Date.now() - nativeMoveStartedAt;
    await saveGeometry();
    geometryStage = 'stale-action';
    const staleAction = request('act', { action: 'click', observation_id: snapshot.observation_id, arguments: { ...stalePoint, delivery_mode: 'foreground' } }).then(result => {
      geometry.staleAction = { status: 'returned', actionFeedback: (result.data as any)?.action_feedback };
      return result;
    }, error => { geometry.staleAction = { status: 'rejected', error: String(error) }; throw error; });
    await assert.rejects(staleAction, /not_dispatched; observation_consumed/);
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#count").textContent'), '21', 'Rejected stale coordinates must not send a click');
    geometryStage = 'fresh-observation';
    snapshot = await observe();
    geometry.freshObservedBounds = snapshot.window_bounds;
    const movedEdge = snapshot.elements.find((e: any) => e.label === 'Edge');
    geometryStage = 'fresh-action';
    const moved = await request('act', { action: 'click', observation_id: snapshot.observation_id, arguments: {
      x: (movedEdge.frame.x + movedEdge.frame.w / 2 - snapshot.window_bounds.x) / snapshot.window_bounds.width,
      y: (movedEdge.frame.y + movedEdge.frame.h / 2 - snapshot.window_bounds.y) / snapshot.window_bounds.height,
      delivery_mode: 'foreground',
    } });
    geometry.freshAction = (moved.data as any)?.action_feedback;
    await until(() => window.webContents.executeJavaScript('document.querySelector("#count").textContent === "31"'));
  } catch (error) { geometry.failure = String(error); throw error; }
  finally {
    driver.call = callDriver;
    geometry.afterMove = window.getBounds();
    geometry.count = await window.webContents.executeJavaScript('document.querySelector("#count").textContent');
    await saveGeometry();
  }
  report.checks.push('Moving/resizing the window rejects stale coordinates without input; a fresh observation hits the edge target');

  // DOM is a read-only oracle for fixture geometry/state; scroll and drag are
  // sent through the same real native driver as model actions.
  const fixturePoint = async (selector: string, horizontal = .5) => {
    const rect = await window.webContents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const content = window.getContentBounds(), bounds = snapshot.window_bounds;
    return { x: (content.x + rect.x + rect.width * horizontal - bounds.x) / bounds.width, y: (content.y + rect.y + rect.height / 2 - bounds.y) / bounds.height };
  };
  snapshot = await observe();
  const scrollPoint = await fixturePoint('#scroll');
  const scrollBefore = await window.webContents.executeJavaScript('document.querySelector("#scroll").scrollTop');
  const scrolled = await request('act', { action: 'scroll', observation_id: snapshot.observation_id, arguments: { ...scrollPoint, direction: 'down', by: 'line', amount: 5, delivery_mode: 'foreground' } });
  await until(async () => await window.webContents.executeJavaScript('document.querySelector("#scroll").scrollTop') > scrollBefore);
  const scrollAfter = await window.webContents.executeJavaScript('document.querySelector("#scroll").scrollTop');
  await writeFile(join(data, 'scroll.json'), JSON.stringify({ scrollPoint, before: scrollBefore, after: scrollAfter, action: scrolled.data }, null, 2));
  if (scrolled.images[0]) await writeFile(join(data, 'scroll.png'), Buffer.from(scrolled.images[0].dataBase64, 'base64'));
  report.checks.push('A native wheel scroll changes the targeted nested scroller, verified by independent scrollTop readback');

  snapshot = await observe();
  const from = await fixturePoint('#slider', .05), to = await fixturePoint('#slider', .85);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slider").value'), '0');
  const dragged = await request('act', { action: 'drag', observation_id: snapshot.observation_id, arguments: { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, duration_ms: 600, steps: 20, delivery_mode: 'foreground' } });
  await until(() => window.webContents.executeJavaScript('Number(document.querySelector("#slider").value) > 60 && window.fixtureDragMoves > 0'));
  const dragState = await window.webContents.executeJavaScript('({ value: Number(document.querySelector("#slider").value), trustedMoves: window.fixtureDragMoves })');
  await writeFile(join(data, 'drag.json'), JSON.stringify({ from, to, state: dragState, action: dragged.data }, null, 2));
  if (dragged.images[0]) await writeFile(join(data, 'drag.png'), Buffer.from(dragged.images[0].dataBase64, 'base64'));
  report.checks.push('A native press-drag-release changes the range value and emits trusted dragging moves');

  if (process.platform === 'darwin') {
    // Native acknowledgements do not prove CGEvent modifier flags reached the
    // renderer. Record actual trusted keydowns and their exact target instead.
    type KeyEvidence = { key: string; code: string; trusted: boolean; meta: boolean; alt: boolean; ctrl: boolean; shift: boolean; target: string; focused: boolean };
    const modifiers: { name: string; action: string; args: Record<string, unknown>; events: KeyEvidence[]; result?: unknown }[] = [];
    snapshot = await observe();
    await request('act', { action: 'click', observation_id: snapshot.observation_id, arguments: { ...await fixturePoint('#input'), delivery_mode: 'foreground' } });
    const checkModifiers = async (name: string, keys: string[], ax = false, singleKey = false) => {
      snapshot = await observe();
      const input = snapshot.elements.find((element: any) => element.label?.includes('Native input') && /textfield|textarea|edit|entry/i.test(element.role));
      assert.ok(input, 'Modifier fixture input missing from fresh native AX tree');
      await window.webContents.executeJavaScript('window.fixtureKeys = []; window.fixtureCaptureKeys = true;');
      const action = singleKey ? 'press_key' : 'hotkey';
      const args = { delivery_mode: 'foreground', ...(singleKey ? { key: 'k' } : { keys }), ...(ax ? { element_index: input.element_index } : {}) };
      let result;
      let events: KeyEvidence[] = [];
      try {
        result = await request('act', { action, observation_id: snapshot.observation_id, arguments: args });
        await until(() => window.webContents.executeJavaScript('window.fixtureKeys.some(event => event.code === "KeyK")'));
      } finally {
        events = await window.webContents.executeJavaScript('window.fixtureKeys');
        modifiers.push({ name, action, args, events, result: result?.data });
        await writeFile(join(data, 'modifier-evidence.json'), JSON.stringify(modifiers, null, 2));
      }
      const key = events.find(event => event.code === 'KeyK')!;
      assert.ok(key.trusted && key.focused, `${name}: expected a trusted keydown in the foreground document`);
      assert.equal(key.target, 'input', `${name}: keydown reached the wrong control`);
      assert.deepEqual({ meta: key.meta, alt: key.alt, ctrl: key.ctrl, shift: key.shift }, {
        meta: keys.includes('cmd'), alt: keys.includes('alt'), ctrl: keys.includes('ctrl'), shift: keys.includes('shift'),
      }, `${name}: native modifier flags did not match the requested keys`);
    };
    for (const modifier of ['cmd', 'alt', 'ctrl', 'shift']) await checkModifiers(`No-coordinate ${modifier}+k`, [modifier, 'k']);
    report.checks.push('Foreground hotkeys without coordinates emit trusted keydowns with exact Command, Option, Control and Shift flags');
    snapshot = await observe();
    await request('act', { action: 'click', observation_id: snapshot.observation_id, arguments: { ...await fixturePoint('#slider'), delivery_mode: 'foreground' } });
    await checkModifiers('AX-focused combined modifiers', ['cmd', 'alt', 'ctrl', 'shift', 'k'], true);
    await checkModifiers('Plain key after modifier release', [], false, true);
    report.checks.push('An AX-targeted hotkey focuses the observed input and preserves all modifier flags; the next plain key has none');
    await window.webContents.executeJavaScript('window.fixtureCaptureKeys = false;');

    // Both focus destinations belong to this test process. Start switching only
    // after independent DOM evidence proves some native text already arrived.
    focusProbe = new BrowserWindow({ title: 'DSH Focus Guard Fixture', width: 340, height: 220, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await focusProbe.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>DSH Focus Guard Fixture</title><textarea id="escaped" autofocus aria-label="Unexpected input destination"></textarea>'));
    await focusProbe.webContents.executeJavaScript('window.escapedKeys = []; document.addEventListener("keydown", event => window.escapedKeys.push({ key: event.key, trusted: event.isTrusted }));');
    snapshot = await observe();
    const input = snapshot.elements.find((element: any) => element.label?.includes('Native input') && /textfield|textarea|edit|entry/i.test(element.role));
    assert.ok(input, 'Focus guard input missing from native AX tree');
    await request('act', { action: 'hotkey', observation_id: snapshot.observation_id, arguments: { element_index: input.element_index, keys: ['cmd', 'a'], delivery_mode: 'foreground' } });
    snapshot = await observe();
    await window.webContents.executeJavaScript('window.fixtureInputEvents = []; window.fixtureTraceTyping = true;');
    const text = 'a'.repeat(120);
    const completion = request('act', { action: 'type_text', observation_id: snapshot.observation_id, arguments: { text, delay_ms: 40, delivery_mode: 'foreground' } })
      .then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    let switched = false;
    try {
      await until(() => window.webContents.executeJavaScript('window.fixtureInputEvents.some(event => event.trusted && event.target === "input" && event.value.length > 0)'));
      await new Promise<void>(resolve => setTimeout(() => { focusProbe!.show(); focusProbe!.focus(); switched = true; resolve(); }, 20));
      await until(async () => !!focusProbe?.isFocused());
      const outcome = await completion;
      await new Promise(resolve => setTimeout(resolve, 150));
      const state = {
        switched, error: String(outcome.error ?? ''), result: outcome.result?.data,
        original: await window.webContents.executeJavaScript('({ value: document.querySelector("#input").value, inputs: window.fixtureInputEvents })'),
        other: await focusProbe.webContents.executeJavaScript('({ value: document.querySelector("#escaped").value, keys: window.escapedKeys })'),
      };
      await writeFile(join(data, 'focus-loss-during-typing.json'), JSON.stringify(state, null, 2));
      assert.ok(outcome.error, 'Long native typing must abort when another window becomes foreground');
      assert.match(state.error, /possibly_dispatched; observation_consumed/);
      assert.match(state.error, /focus|foreground|window|target|前台|焦点|窗口|目标/i);
      assert.ok(state.original.value.length > 0 && state.original.value.length < text.length && text.startsWith(state.original.value), 'The original field must contain a verified partial prefix');
      assert.equal(state.other.value, '', 'Remaining text leaked to another window');
      assert.equal(state.other.keys.length, 0, 'Keyboard events leaked to another window');
      report.checks.push('Long foreground typing aborts after focus changes to another fixture window, with a partial prefix and zero leaked keys/text');
    } finally {
      // Wait for the bounded native request before removing the alternative
      // focus destination, so a failing test cannot leak input to a user app.
      await completion;
      await window.webContents.executeJavaScript('window.fixtureTraceTyping = false;');
      focusProbe.destroy(); focusProbe = undefined;
      snapshot = await observe();
      await request('act', { action: 'bring_to_front', observation_id: snapshot.observation_id, arguments: {} });
    }
  }
  // Hiding/destroying this renderer can suspend its evaluation reply. Verify
  // the native window state instead of waiting for a reply from a hidden page.
  void previewWindow!.webContents.executeJavaScript('window.computerPreview.hide()').catch(() => {});
  await until(async () => !previewWindow!.isVisible());
  await preview.show();
  assert.equal(previewWindow!.isVisible(), true);
  void previewWindow!.webContents.executeJavaScript('document.querySelector("button.stop").click()').catch(() => {});
  await until(async () => broker.state.phase === 'idle');
  report.checks.push('PiP hide/reopen and its actual Stop control release the desktop lease');
  assert.equal(broker.state.phase, 'idle');
  assert.ok(previewWindow!.isDestroyed(), 'Stop left a stale picture-in-picture visible');
}).catch(error => { report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error)); }).finally(finish);
