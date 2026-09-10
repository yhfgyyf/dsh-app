import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopComputerUse } from '../src/main/computer-use.ts';
import { screenshotCoordinates, type ComputerRequest, type ComputerResult } from '../src/shared/computer-use.ts';
import type { ComputerDriver } from '../src/main/computer-use-driver.ts';
import { pngFixture } from './png-fixture.ts';

class Driver implements ComputerDriver {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  previewCalls: Record<string, unknown>[] = [];
  stopped = 0;
  pause?: (signal: AbortSignal) => Promise<void>;
  releaseStop?: Promise<void>;
  permissionState = { supported: true, accessibility: true, screenRecording: true };
  prompts: boolean[] = [];
  starting?: (signal: AbortSignal) => Promise<void>;
  bounds = { x: 0, y: 33, width: 1512, height: 872 };
  windowPresent = true;
  async permissions(prompt = false) { this.prompts.push(prompt); return { ...this.permissionState }; }
  async start(signal: AbortSignal) { await this.starting?.(signal); }
  async describe(): Promise<unknown> { return { tools: [] }; }
  async capturePreview(args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> {
    this.previewCalls.push(args);
    await this.pause?.(signal);
    return { text: 'preview', images: [{ mimeType: 'image/png', dataBase64: pngFixture().toString('base64') }] };
  }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> {
    this.calls.push({ name, args });
    await this.pause?.(signal);
    return { text: 'fixture', data: name === 'list_apps' ? { apps: [{ name: 'Fixture', bundle_id: 'io.dsh.fixture', launch_path: 'C:\\Fixture.exe' }] } : name === 'list_windows' ? { windows: this.windowPresent ? [{ pid: 123, window_id: 456, bounds: { ...this.bounds } }] : [] } : { snapshot_id: 's12345678', window_bounds: { ...this.bounds }, screenshot_scale: 2, elements: [{ element_index: 2, element_token: 'fixture-element' }], effect: 'confirmed' }, images: name === 'get_window_state' ? [{ mimeType: 'image/png', dataBase64: pngFixture().toString('base64') }] : [] };
  }
  async stop() { this.stopped++; await this.releaseStop; }
}
const request = (sessionId: string, operation: ComputerRequest['operation'], args: Record<string, unknown> = {}): ComputerRequest => ({ id: 'fixture', sessionId, operation, arguments: args });
const signal = () => AbortSignal.timeout(10000);
async function fixture(scope?: number) {
  const driver = new Driver(); const broker = new DesktopComputerUse(driver);
  await broker.setEnabled(true, false);
  await broker.request(request('a', 'start', { reason: 'Isolated test', ...(scope ? { application_pid: scope } : {}) }), signal());
  return { driver, broker };
}
async function observe(broker: DesktopComputerUse) {
  const result = await broker.request(request('a', 'observe', { kind: 'window', pid: 123, window_id: 456 }), signal());
  return (result.data as { observation_id: string }).observation_id;
}

test('desktop lease excludes other sessions and enforces application scope', async () => {
  const { driver, broker } = await fixture(123);
  try {
    await assert.rejects(broker.request(request('b', 'start', { reason: 'competitor' }), signal()), /占用/);
    await assert.rejects(broker.request(request('b', 'stop'), signal()), /其他会话/);
    await assert.rejects(broker.request(request('a', 'observe', { kind: 'window', pid: 124, window_id: 456 }), signal()), /授权范围/);
    await assert.rejects(broker.request(request('a', 'observe', { kind: 'desktop' }), signal()), /仅限一个应用/);
    assert.equal(driver.calls.length, 0);
  } finally { await broker.stop(); }
});

test('computer is off by default and requires both permissions and a working driver', async () => {
  const driver = new Driver(); const broker = new DesktopComputerUse(driver);
  assert.equal((await broker.permissions()).enabled, false);
  await assert.rejects(broker.request(request('a', 'start', { reason: 'test' }), signal()), /开关/);
  for (const permissions of [{ supported: false, accessibility: true, screenRecording: true }, { supported: true, accessibility: false, screenRecording: true }, { supported: true, accessibility: true, screenRecording: false }]) {
    driver.permissionState = permissions;
    assert.equal((await broker.setEnabled(true)).enabled, false);
    assert.equal(driver.prompts.at(-1), true);
    assert.ok(broker.state.error, 'A failed enable must explain why the switch remained off');
  }
  driver.permissionState = { supported: true, accessibility: true, screenRecording: true };
  driver.starting = async () => { throw new Error('fixture driver failed'); };
  assert.equal((await broker.setEnabled(true)).enabled, false);
  assert.match(broker.state.error!, /fixture driver failed/);
  driver.starting = undefined;
  assert.equal((await broker.permissions()).enabled, true);
  await broker.setEnabled(false);
});

test('the enabled switch authorizes successive tasks without per-task approval', async () => {
  const driver = new Driver(); const broker = new DesktopComputerUse(driver);
  try {
    await broker.setEnabled(true, false);
    for (const sessionId of ['first', 'second']) {
      const result = await broker.request(request(sessionId, 'start', { reason: 'Switch-authorized test', application_pid: 123 }), signal());
      assert.equal((result.data as any).approvedBy, 'desktop-switch');
      assert.equal(broker.state.phase, 'active');
      assert.equal(broker.state.owner?.sessionId, sessionId);
      await broker.request(request(sessionId, 'stop'), signal());
      assert.equal(broker.state.enabled, true);
    }
    await broker.setEnabled(false);
    await assert.rejects(broker.request(request('third', 'start', { reason: 'Disabled' }), signal()), /开关/);
    assert.equal(driver.calls.length, 0);
  } finally { await broker.stop(); }
});

test('revoking permission ends the active lease and disables the switch; returning from settings rechecks permission', async () => {
  const { driver, broker } = await fixture();
  driver.permissionState.screenRecording = false;
  assert.equal((await broker.permissions()).enabled, false);
  assert.equal(broker.state.owner, undefined);
  await assert.rejects(broker.request(request('a', 'observe', { kind: 'desktop' }), signal()), /开关/);
  driver.permissionState.screenRecording = true;
  assert.equal((await broker.permissions()).enabled, true);
  assert.equal(driver.prompts.at(-1), false);
  await broker.setEnabled(false);
  assert.equal((await broker.permissions()).enabled, false);
});

test('disabling during driver startup cannot be undone by a late startup result', async () => {
  const driver = new Driver(); const states: boolean[] = [];
  const broker = new DesktopComputerUse(driver, state => states.push(state.enabled));
  let entered!: () => void; const starting = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  driver.starting = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
  const enabling = broker.setEnabled(true);
  await starting;
  assert.equal(broker.state.enabled, false);
  await broker.setEnabled(false);
  release(); await enabling;
  assert.equal(broker.state.enabled, false);
  assert.ok(states.every(enabled => !enabled));
  driver.starting = undefined;
  assert.equal((await broker.setEnabled(true)).enabled, true);
  await broker.setEnabled(false);
});

test('actions bind the exact observed target and consume their snapshot', async () => {
  const { driver, broker } = await fixture();
  try {
    let id = await observe(broker);
    await broker.request(request('a', 'act', { action: 'click', observation_id: id, observe_after: false, arguments: { element_index: 2 } }), signal());
    assert.deepEqual(driver.calls.at(-1), { name: 'click', args: { element_index: 2, pid: 123, window_id: 456, snapshot_id: 's12345678' } });
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { element_index: 2 } }), signal()), /观察已失效/);
    id = await observe(broker);
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { pid: 999 } }), signal()), /不支持的参数/);
    id = await observe(broker);
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { element_token: 'foreign' } }), signal()), /不属于/);
    id = await observe(broker);
    await broker.request(request('a', 'act', { action: 'click', observation_id: id, observe_after: false, arguments: { x: 0.5, y: 1 } }), signal());
    assert.deepEqual(driver.calls.at(-1)?.args, { x: 16, y: 31, pid: 123, window_id: 456 });
  } finally { await broker.stop(); }
});

test('launch only uses the installed application selected in the latest observation', async () => {
  const { driver, broker } = await fixture();
  try {
    const result = await broker.request(request('a', 'observe', { kind: 'apps' }), signal());
    await broker.request(request('a', 'act', { action: 'launch_app', observation_id: (result.data as any).observation_id, arguments: { app_index: 0 } }), signal());
    assert.equal(driver.calls.at(-1)?.name, 'launch_app');
    assert.ok(!('additional_arguments' in driver.calls.at(-1)!.args));
  } finally { await broker.stop(); }
});

test('cancellation aborts native work and keeps the lease until the driver has stopped', async () => {
  const { driver, broker } = await fixture();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let released!: () => void; driver.releaseStop = new Promise<void>(resolve => { released = resolve; });
  driver.pause = signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered(); });
  const controller = new AbortController();
  const running = broker.request(request('a', 'observe', { kind: 'window', pid: 123, window_id: 456 }), controller.signal);
  await started; controller.abort();
  assert.equal(broker.state.phase, 'stopping'); assert.equal(broker.state.owner?.sessionId, 'a');
  await assert.rejects(broker.request(request('b', 'start', { reason: 'competitor' }), signal()));
  released(); await assert.rejects(running);
  assert.equal(broker.state.phase, 'idle'); assert.equal(broker.state.owner, undefined); assert.equal(driver.stopped, 1);
});

test('normalized coordinates reject NaN, off-image values and missing frame dimensions', () => {
  for (const x of [NaN, Infinity, -0.1, 1.1, '0.5']) assert.throws(() => screenshotCoordinates({ x }, 200, 100));
  assert.throws(() => screenshotCoordinates({ x: 0.5 }, 0, 0));
  assert.deepEqual(screenshotCoordinates({ from_x: 0.25, from_y: 0.5, to_x: 1, to_y: 0 }, 200, 100), { from_x: 50, from_y: 50, to_x: 199, to_y: 0 });
});

test('disabling cancels task startup and a late driver result cannot restore ownership', async () => {
  const driver = new Driver();
  const broker = new DesktopComputerUse(driver);
  await broker.setEnabled(true, false);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  driver.starting = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
  const starting = broker.request(request('a', 'start', { reason: 'test', application_pid: 123 }), signal());
  const rejected = assert.rejects(starting, /停止/);
  await waiting;
  assert.equal(broker.state.phase, 'starting');
  await broker.setEnabled(false);
  release();
  await rejected;
  assert.equal(broker.state.enabled, false);
  assert.equal(broker.state.phase, 'idle');
  assert.equal(broker.state.owner, undefined);
});

test('actions return a fresh observation, and failed verification never repeats input', async () => {
  const { driver, broker } = await fixture();
  try {
    let id = await observe(broker);
    const result = await broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { element_index: 2 } }), signal());
    assert.ok(result.images.length);
    assert.notEqual((result.data as any).observation_id, id);
    assert.equal((result.data as any).action_result.effect, 'confirmed');
    assert.equal((result.data as any).action_feedback.delivery.status, 'returned');
    assert.equal((result.data as any).action_feedback.delivery.reported_effect, 'confirmed');
    assert.equal((result.data as any).action_feedback.outcome, 'unverified', 'A driver effect is not proof that the model selected the intended target');
    assert.equal((result.data as any).action_feedback.observation.status, 'refreshed');
    assert.deepEqual(driver.calls.slice(-2).map(call => call.name), ['click', 'get_window_state']);
    id = (result.data as any).observation_id;
    driver.pause = async () => { if (driver.calls.at(-1)?.name === 'get_window_state') throw new Error('capture failed'); };
    const failed = await broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { element_index: 2 } }), signal());
    assert.match((failed.data as any).observation_error, /capture failed/);
    assert.equal((failed.data as any).observation_id, undefined);
    assert.equal((failed.data as any).action_feedback.observation.status, 'failed');
    assert.equal((failed.data as any).action_feedback.observation.required_before_next_action, true);
    assert.equal(driver.calls.filter(call => call.name === 'click').length, 2);
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: {} }), signal()), /观察已失效/);
  } finally { await broker.stop(); }
});

test('preview is capture-only and cannot replace agent snapshots or return frames after stop', async () => {
  const { driver, broker } = await fixture(123);
  try {
    assert.equal(await broker.preview(), undefined);
    const id = await observe(broker);
    const preview = await broker.preview();
    assert.ok(preview?.image);
    assert.deepEqual(driver.previewCalls.at(-1), { pid: 123, window_id: 456, include_screenshot: true, include_accessibility_tree: false, max_dimension: 640 });
    assert.equal(driver.calls.length, 1, 'PiP must not touch the action worker frame cache');
    await broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { element_index: 2 } }), signal());
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    driver.pause = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
    const capturing = broker.preview();
    await waiting;
    await broker.stop();
    release();
    assert.equal(await capturing, undefined);
    assert.equal(await broker.preview(), undefined);
    assert.equal(broker.state.target, undefined);
  } finally { await broker.stop(); }
});

test('action descriptions expose only the normalized host contract and support focused lookup', async () => {
  const { driver, broker } = await fixture();
  driver.describe = async () => ({ tools: [{ name: 'click', description: 'Use screenshot pixels and from_zoom, pid and window_id.', inputSchema: {
    required: ['pid', 'window_id'], properties: { x: { type: 'number', description: 'X in screenshot pixels' }, y: { type: 'number', description: 'Y in pixels' }, delivery_mode: { type: 'string', description: 'Native from_zoom screenshot pixels target handles.' }, modifier: { type: 'string', description: 'Native modifier with window_id and screenshot pixels.' }, from_zoom: { type: 'boolean' }, pid: { type: 'integer' }, window_id: { type: 'integer' } },
  } }] });
  try {
    const index = await broker.request(request('a', 'observe', { kind: 'describe' }), signal());
    assert.ok(!JSON.stringify(index.data).includes('screenshot pixels'));
    assert.ok(!(index.data as any).actions[0].parameters, 'The index must not repeat every native schema');
    const result = await broker.request(request('a', 'observe', { kind: 'describe', action: 'click' }), signal());
    const action = (result.data as any).actions[0];
    assert.equal(action.parameters.x.minimum, 0);
    assert.equal(action.parameters.x.maximum, 1);
    assert.match(action.parameters.x.description, /normalized/);
    assert.doesNotMatch(JSON.stringify(action.parameters), /screenshot pixels|from_zoom|window_id/);
    assert.deepEqual(action.required, []);
    for (const field of ['pid', 'window_id', 'from_zoom']) assert.ok(!(field in action.parameters));
    await assert.rejects(broker.request(request('a', 'observe', { kind: 'describe', action: 'unknown' }), signal()), /操作/);
  } finally { await broker.stop(); }
});

test('action feedback binds submitted coordinates to the observed frame and distinguishes unchanged pixels', async () => {
  const { broker } = await fixture();
  try {
    const id = await observe(broker);
    const result = await broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { x: .5, y: .25, delivery_mode: 'foreground' } }), signal());
    const feedback = (result.data as any).action_feedback;
    assert.equal(feedback.observation_id, id);
    assert.deepEqual(feedback.coordinates.normalized, { x: .5, y: .25 });
    assert.deepEqual(feedback.coordinates.screenshot_pixels, { x: 16, y: 8 });
    assert.deepEqual(feedback.screenshot_dimensions, { width: 32, height: 32 });
    assert.equal(feedback.screenshot_changed, false);
    assert.equal(feedback.outcome, 'unverified');
    assert.match(result.text, /相同/);
  } finally { await broker.stop(); }
});

test('native action failures retain the error and identify the exact re-observation needed', async () => {
  const { driver, broker } = await fixture();
  try {
    const id = await observe(broker);
    driver.pause = async () => { throw new Error('menu_path_unavailable: missing item'); };
    await assert.rejects(broker.request(request('a', 'act', { action: 'invoke_menu', observation_id: id, arguments: { path: ['Missing'] } }), signal()), error => {
      assert.match(String(error), /possibly_dispatched; observation_consumed/);
      assert.match(String(error), /menu_path_unavailable/);
      assert.match(String(error), /computer_observe/);
      assert.match(String(error), /"pid":123/);
      assert.match(String(error), /"window_id":456/);
      return true;
    });
    driver.pause = undefined;
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { x: .5, y: .5 } }), signal()), /观察已失效/);
    assert.equal(driver.calls.filter(call => call.name === 'invoke_menu').length, 1);
    await observe(broker);
  } finally { await broker.stop(); }
});

test('keyboard preparation rejects ambiguous targets and implicit clipboard changes before input', async () => {
  const { driver, broker } = await fixture(123);
  try {
    for (const args of [
      { x: .5 },
      { x: .5, y: .5, element_index: 2 },
      { method: 'unknown' },
      { method: 'paste', delivery_mode: 'background' },
    ]) {
      const id = await observe(broker), count = driver.calls.length;
      await assert.rejects(broker.request(request('a', 'act', { action: 'type_text', observation_id: id, arguments: { text: 'fixture', ...args } }), signal()));
      assert.equal(driver.calls.length, count, 'Invalid requests must not focus a field or change the clipboard');
    }
  } finally { await broker.stop(); }
});

test('local validation failures preserve a usable observation without sending input', async () => {
  const { driver, broker } = await fixture();
  try {
    const id = await observe(broker), count = driver.calls.length;
    for (const arguments_ of [{ x: .5 }, { x: .5, y: .5, element_index: 2 }, { x: 1.1, y: .5 }, { delivery_mode: 'automatic', x: .5, y: .5 }]) {
      await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: arguments_ }), signal()), /not_dispatched; observation_retained/);
      assert.equal(driver.calls.length, count);
    }
    await broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { x: .5, y: .5 } }), signal());
    assert.equal(driver.calls.filter(call => call.name === 'click').length, 1);
  } finally { await broker.stop(); }
});

test('coordinate actions refuse moved, resized or missing windows before input', async () => {
  const { driver, broker } = await fixture();
  try {
    for (const change of [() => { driver.bounds.x += 20; }, () => { driver.bounds.height += 20; }, () => { driver.windowPresent = false; }]) {
      const id = await observe(broker);
      change();
      await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { x: .5, y: .5 } }), signal()), /窗口.*重新观察/);
      assert.equal(driver.calls.filter(call => call.name === 'click').length, 0);
      await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { x: .5, y: .5 } }), signal()), /观察已失效/);
    }
  } finally { await broker.stop(); }
});

test('observation reports the delivered PNG frame without exposing a stale native scale', async () => {
  const { broker } = await fixture();
  try {
    const result = await broker.request(request('a', 'observe', { kind: 'window', pid: 123, window_id: 456 }), signal());
    assert.deepEqual((result.data as any).screenshot_dimensions, { width: 32, height: 32 });
    assert.equal((result.data as any).screenshot_scale, undefined);
    assert.equal((result.data as any).coordinate_origin, 'top_left_of_complete_screenshot');
  } finally { await broker.stop(); }
});

test('failed geometry verification consumes an unusable frame without dispatching input', async () => {
  const { driver, broker } = await fixture();
  try {
    const id = await observe(broker);
    driver.pause = async () => { if (driver.calls.at(-1)?.name === 'list_windows') throw new Error('window server unavailable'); };
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { x: .5, y: .5 } }), signal()), /not_dispatched; observation_consumed/);
    driver.pause = undefined;
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { x: .5, y: .5 } }), signal()), /观察已失效/);
    assert.equal(driver.calls.filter(call => call.name === 'click').length, 0);
    const fresh = await observe(broker);
    await broker.request(request('a', 'act', { action: 'click', observation_id: fresh, arguments: { x: .5, y: .5 } }), signal());
    assert.equal(driver.calls.filter(call => call.name === 'click').length, 1);
  } finally { await broker.stop(); }
});

test('an expired frame is not advertised as reusable after local validation', async () => {
  const { broker } = await fixture();
  const now = Date.now;
  try {
    const id = await observe(broker);
    Date.now = () => now() + 61000;
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { x: .5, y: .5 } }), signal()), error => {
      assert.match(String(error), /观察已失效/);
      assert.doesNotMatch(String(error), /observation_retained/);
      return true;
    });
  } finally { Date.now = now; await broker.stop(); }
});
