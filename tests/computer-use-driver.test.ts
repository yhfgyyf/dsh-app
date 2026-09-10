import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CuaComputerDriver, verifyMacDriverPatch } from '../src/main/computer-use-driver.ts';

test('macOS refuses an unpatched or mismatched native runtime before input', async () => {
  await mkdir(join(process.cwd(), '.test-data'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.test-data/driver-patch-'));
  const directory = join(root, 'computer-use');
  await mkdir(directory);
  await assert.rejects(verifyMacDriverPatch(root), /前台输入补丁/);
  const pin = { patchId: 'dsh-macos-foreground-v2', sourceCommit: 'commit', sourceTree: 'tree', patchSha256: 'patch', cargoLockSha256: 'lock', toolchain: '1.97.1' };
  await writeFile(join(directory, 'native-patch.json'), JSON.stringify(pin));
  await writeFile(join(directory, 'driver-build.json'), JSON.stringify({ ...pin, patchSha256: 'older-patch' }));
  await assert.rejects(verifyMacDriverPatch(root), /前台输入补丁/);
  await writeFile(join(directory, 'driver-build.json'), JSON.stringify(pin));
  await verifyMacDriverPatch(root);
  const stale = { ...pin, patchId: 'dsh-macos-foreground-v1' };
  await writeFile(join(directory, 'native-patch.json'), JSON.stringify(stale));
  await writeFile(join(directory, 'driver-build.json'), JSON.stringify(stale));
  await assert.rejects(verifyMacDriverPatch(root), /前台输入补丁/);
});

function fixture(run: (name: string, args: any) => unknown, platform: NodeJS.Platform = 'darwin') {
  const driver = new CuaComputerDriver({ runtimeRoot: '/unused', hostBundleId: 'fixture', platform });
  // Exercise the adapter against a native transport with observable input effects.
  Object.assign(driver, { driver: { callTool: async (name: string, json: string) => ({ text: '', images: [], isError: false, structuredJson: JSON.stringify(run(name, JSON.parse(json))) }) } });
  return driver;
}
const target = { pid: 123, window_id: 456, x: 100, y: 200, delivery_mode: 'foreground' };
const focusedWindow = { pid: 123, window_id: 456, delivery_mode: 'foreground' };

test('foreground hotkeys use exact-window HID without refocusing an existing selection', async () => {
  const calls: string[] = [];
  const driver = fixture((name, args) => {
    calls.push(name);
    assert.equal(name, 'hotkey', 'No activation or focus click may precede this chord');
    assert.deepEqual(args, { ...focusedWindow, keys: ['command', 'shift', 'a'] });
    return { effect: 'unverifiable' };
  });
  await driver.call('hotkey', { ...focusedWindow, keys: ['command', 'shift', 'a'] }, AbortSignal.timeout(1000));
  assert.deepEqual(calls, ['hotkey']);
});

test('focus once, select all and paste preserve the selection and exact target', async () => {
  let selected = false, value = 'old contents', clipboard = '';
  const calls: string[] = [];
  const driver = fixture((name, args) => {
    calls.push(name);
    if (['bring_to_front', 'click'].includes(name)) selected = false;
    if (name === 'clipboard_write') clipboard = args.text;
    if (name === 'clipboard_read') return { text: clipboard };
    if (name === 'press_key' || name === 'hotkey') {
      assert.equal(args.pid, 123); assert.equal(args.window_id, 456);
      assert.equal(args.scope, undefined);
      const key = args.key ?? args.keys.at(-1);
      if (key === 'a') selected = true;
      if (key === 'v') { value = selected ? clipboard : value + clipboard; selected = false; }
    }
    return { effect: 'unverifiable' };
  });
  await driver.call('hotkey', { ...target, keys: ['cmd', 'a'] }, AbortSignal.timeout(1000));
  await driver.call('type_text', { ...focusedWindow, method: 'paste', text: 'new 中文\ncontents' }, AbortSignal.timeout(1000));
  assert.equal(value, 'new 中文\ncontents');
  assert.deepEqual(calls, ['bring_to_front', 'click', 'hotkey', 'clipboard_write', 'clipboard_read', 'hotkey']);
});

test('an explicitly addressed keyboard action focuses once before delivery', async () => {
  for (const action of [
    { name: 'hotkey', args: { keys: ['shift', 'f11'] }, delivered: 'hotkey' },
    { name: 'type_text', args: { text: 'new value', delay_ms: 20 }, delivered: 'type_text' },
  ]) {
    const calls: string[] = [];
    const driver = fixture((name, args) => {
      calls.push(name);
      if (name === action.delivered) {
        assert.equal(args.x, undefined, 'The native input must not focus a second time');
        assert.equal(args.y, undefined);
      }
      return { effect: 'unverifiable' };
    });
    await driver.call(action.name, { ...target, ...action.args }, AbortSignal.timeout(1000));
    assert.deepEqual(calls, ['bring_to_front', 'click', action.delivered]);
  }
});

test('AX hotkeys retain native strict focus and pixel fallback instead of best-effort key focus', async () => {
  let count = 0;
  const driver = fixture((name, args) => {
    count++;
    assert.equal(name, 'hotkey');
    assert.deepEqual(args, { ...focusedWindow, element_index: 7, snapshot_id: 'snapshot-1', keys: ['cmd', 'v'] });
    return { effect: 'unverifiable' };
  });
  for (const keys of [[], ['cmd'], ['cmd', 'a', 'b'], ['cmd', 1]]) {
    await assert.rejects(driver.call('hotkey', { ...target, keys }, AbortSignal.timeout(1000)), /keys/);
  }
  assert.equal(count, 0);
  await driver.call('hotkey', { ...focusedWindow, element_index: 7, snapshot_id: 'snapshot-1', keys: ['cmd', 'v'] }, AbortSignal.timeout(1000));
  assert.equal(count, 1);
});

test('AX paste retains strict native focus and does not type into the previous field', async () => {
  let clipboard = '', previousField = 'untouched', targetField = '';
  const driver = fixture((name, args) => {
    if (name === 'clipboard_write') clipboard = args.text;
    if (name === 'clipboard_read') return { text: clipboard };
    if (name === 'press_key') previousField += clipboard;
    if (name === 'hotkey') {
      assert.deepEqual(args, { ...focusedWindow, element_token: 'snapshot:7', keys: ['cmd', 'v'] });
      targetField = clipboard;
    }
    return { effect: 'unverifiable' };
  });
  await driver.call('type_text', { ...focusedWindow, element_token: 'snapshot:7', method: 'paste', text: 'target 中文' }, AbortSignal.timeout(1000));
  assert.equal(targetField, 'target 中文');
  assert.equal(previousField, 'untouched');
});

test('macOS canvas keys reach foreground HID with the exact window retained', async () => {
  let front = false, focused = false, delivered = false;
  const driver = fixture((name, args) => {
    assert.equal(args.pid, 123); assert.equal(args.window_id, 456);
    assert.equal(args.scope, undefined, 'A window action must never become desktop input');
    if (name === 'bring_to_front') front = true;
    if (name === 'click') { assert.deepEqual([args.x, args.y], [100, 200]); focused = true; }
    if (name === 'press_key') {
      assert.ok(front && focused);
      assert.equal(args.x, undefined, 'Native 0.25 press_key with x/y uses PID delivery');
      assert.deepEqual([args.key, args.modifiers], ['f11', ['shift']]);
      delivered = true;
    }
    return { effect: 'unverifiable' };
  });
  await driver.call('press_key', { ...target, key: 'f11', modifiers: ['shift'] }, AbortSignal.timeout(1000));
  assert.ok(delivered);
});

test('paste requires exact clipboard readback and never retries character input', async () => {
  for (const matches of [false, true]) {
    let clipboard = '', pastes = 0;
    const driver = fixture((name, args) => {
      assert.notEqual(name, 'type_text', 'Paste must not risk duplicating partially typed text');
      if (name === 'clipboard_write') clipboard = args.text;
      if (name === 'clipboard_read') return { text: matches ? clipboard : 'concurrent clipboard change', types: ['public.utf8-plain-text'] };
      if (name === 'hotkey') {
        assert.deepEqual(args, { ...focusedWindow, keys: ['cmd', 'v'] });
        pastes++;
      }
      return { effect: 'unverifiable' };
    });
    const result = driver.call('type_text', { ...target, method: 'paste', text: 'DSH 中文\nsecond line' }, AbortSignal.timeout(1000));
    if (matches) assert.equal(((await result).data as any)?.input_method, 'clipboard_paste');
    else await assert.rejects(result, /剪贴板读回/);
    assert.equal(pastes, matches ? 1 : 0);
  }
});

test('failed activation cannot send keys and background input stays background', async () => {
  let mutations = 0;
  const driver = fixture((name, args) => {
    if (name === 'bring_to_front') throw new Error('Exact window activation failed');
    assert.equal(args.delivery_mode, 'background'); mutations++;
    return { effect: 'unverifiable' };
  });
  await assert.rejects(driver.call('hotkey', { ...target, keys: ['shift', 'f11'] }, AbortSignal.timeout(1000)), /activation failed/);
  assert.equal(mutations, 0);
  await driver.call('hotkey', { ...target, delivery_mode: 'background', keys: ['shift', 'f11'] }, AbortSignal.timeout(1000));
  assert.equal(mutations, 1);
});

test('non-macOS and background hotkeys retain their native delivery contract', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const args = { ...target, keys: ['ctrl', 'a'], ...(platform === 'darwin' ? { delivery_mode: 'background' } : {}) };
    const calls: string[] = [];
    const driver = fixture((name, delivered) => {
      calls.push(name);
      assert.deepEqual(delivered, args);
      return { effect: 'unverifiable' };
    }, platform);
    await driver.call('hotkey', args, AbortSignal.timeout(1000));
    assert.deepEqual(calls, ['hotkey']);
  }
});

test('a possibly delivered key failure never retries or changes transport', async () => {
  let attempts = 0;
  const driver = fixture((name, args) => {
    assert.equal(name, 'hotkey');
    assert.deepEqual(args, { ...focusedWindow, keys: ['cmd', 'v'] });
    attempts++;
    throw new Error('Input result unavailable after posting');
  });
  await assert.rejects(driver.call('hotkey', { ...focusedWindow, keys: ['cmd', 'v'] }, AbortSignal.timeout(1000)), /after posting/);
  assert.equal(attempts, 1);
});
