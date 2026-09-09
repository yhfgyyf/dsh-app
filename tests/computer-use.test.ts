import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopComputerUse } from '../src/main/computer-use.ts';
import { screenshotCoordinates, type ComputerRequest, type ComputerResult } from '../src/shared/computer-use.ts';
import type { ComputerDriver } from '../src/main/computer-use-driver.ts';
import { pngFixture } from './png-fixture.ts';

class Driver implements ComputerDriver {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  stopped = 0;
  pause?: (signal: AbortSignal) => Promise<void>;
  releaseStop?: Promise<void>;
  async permissions() { return { supported: true, accessibility: true, screenRecording: true }; }
  async start() {}
  async describe() { return { tools: [] }; }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> {
    this.calls.push({ name, args });
    await this.pause?.(signal);
    return { text: 'fixture', data: name === 'list_apps' ? { apps: [{ name: 'Fixture', bundle_id: 'io.dsh.fixture', launch_path: 'C:\\Fixture.exe' }] } : { snapshot_id: 's12345678', elements: [{ element_index: 2, element_token: 'fixture-element' }], effect: 'confirmed' }, images: name === 'get_window_state' ? [{ mimeType: 'image/png', dataBase64: pngFixture().toString('base64') }] : [] };
  }
  async stop() { this.stopped++; await this.releaseStop; }
}
const request = (sessionId: string, operation: ComputerRequest['operation'], args: Record<string, unknown> = {}): ComputerRequest => ({ id: 'fixture', sessionId, operation, arguments: args });
const signal = () => AbortSignal.timeout(10000);
async function fixture(scope?: number) {
  const driver = new Driver(); const broker = new DesktopComputerUse(driver);
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

test('actions bind the exact observed target and consume their snapshot', async () => {
  const { driver, broker } = await fixture();
  try {
    let id = await observe(broker);
    await broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { element_index: 2 } }), signal());
    assert.deepEqual(driver.calls.at(-1), { name: 'click', args: { element_index: 2, pid: 123, window_id: 456, snapshot_id: 's12345678' } });
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { element_index: 2 } }), signal()), /观察已失效/);
    id = await observe(broker);
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { pid: 999 } }), signal()), /不支持的参数/);
    id = await observe(broker);
    await assert.rejects(broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { element_token: 'foreign' } }), signal()), /不属于/);
    id = await observe(broker);
    await broker.request(request('a', 'act', { action: 'click', observation_id: id, arguments: { x: 0.5, y: 1 } }), signal());
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
