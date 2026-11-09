import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskNotifications } from '../src/main/task-notifications.ts';
import { installTaskNotifications } from '../src/runtime/task-notifications.ts';
import { readTaskEvent, notificationSessionId, type TaskEvent, type TaskNotice } from '../src/shared/task-notifications.ts';
import { notificationBadgePng, overlayNotificationBadge } from '../src/main/notification-badge.ts';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup() {
  const badges: number[] = [], notices: TaskNotice[] = [], opens: string[] = [], clicks: (() => void)[] = [], closed: number[] = [];
  const control = new TaskNotifications({ badge: count => badges.push(count), openSession: id => opens.push(id), notify(notice, open) {
    const index = notices.length; notices.push(notice); clicks.push(open); return () => { closed.push(index); };
  } });
  const start = (id: string, turn = 1) => control.receive({ kind: 'started', sessionId: id, turn, title: id });
  const end = (id: string, turn = 1, outcome: 'completed' | 'interrupted' | 'stopped' = 'completed') => control.receive({ kind: 'ended', sessionId: id, turn, title: id, outcome });
  return { control, badges, notices, opens, clicks, closed, start, end };
}

test('Linux fallback keeps the app icon and composites only its top-right numeric badge', () => {
  const base = Buffer.alloc(64 * 64 * 4), badge = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < base.length; i += 4) base.set([20, 40, 60, 255], i);
  badge.set([30, 30, 124, 128], 0); // Premultiplied half-transparent red.
  badge.set([255, 255, 255, 255], 4);
  const result = overlayNotificationBadge(base, badge);
  assert.deepEqual([...result.subarray(32 * 4, 32 * 4 + 8)], [40, 50, 154, 255, 255, 255, 255, 255]);
  assert.deepEqual(result.subarray(0, 32 * 4), base.subarray(0, 32 * 4));
  assert.deepEqual(result.subarray(32 * 64 * 4), base.subarray(32 * 64 * 4));
  assert.deepEqual([...base.subarray(32 * 4, 32 * 4 + 4)], [20, 40, 60, 255]);
  assert.throws(() => overlayNotificationBadge(Buffer.alloc(4), badge));
});

test('background tasks notify once per live turn and badge counts unread conversations', () => {
  const f = setup(); f.end('orphan'); assert.equal(f.control.count, 0);
  f.start('a'); f.end('a'); f.end('a');
  assert.equal(f.notices.length, 1); assert.equal(f.control.count, 1);
  f.start('a', 2); f.end('a', 1); assert.equal(f.notices.length, 1); f.end('a', 2);
  assert.equal(f.control.count, 1); assert.deepEqual(f.closed, [0]);
  f.start('b'); f.end('b', 1, 'interrupted'); assert.equal(f.control.count, 2);
  assert.equal(f.notices.at(-1)?.outcome, 'interrupted');
});

test('only a focused visible conversation is read; switching or returning clears its count', () => {
  const f = setup(); f.control.setView('a'); f.start('a'); f.end('a');
  assert.equal(f.control.count, 1, 'A selected but background conversation is still unread');
  f.control.setFocused(true); assert.equal(f.control.count, 0);
  f.start('a', 2); f.end('a', 2); assert.equal(f.notices.length, 1);
  f.start('b'); f.end('b'); assert.equal(f.control.count, 1);
  f.control.setView(undefined); f.control.setFocused(false); f.control.setView('b'); assert.equal(f.control.count, 1);
  f.control.setFocused(true); assert.equal(f.control.count, 0);
  assert.equal(f.badges.at(-1), 0);
});

test('notification click opens its exact session and clears only that reminder', () => {
  const f = setup(); for (const id of ['a', 'b']) { f.start(id); f.end(id); }
  f.clicks[1](); assert.deepEqual(f.opens, ['b']); assert.equal(f.control.count, 1);
  f.control.dispose(); assert.equal(f.badges.at(-1), 0);
  f.start('after-quit'); f.end('after-quit'); assert.equal(f.control.count, 0);
});

test('manual cancellation is silent; core failure reports only currently running tasks once', () => {
  const f = setup(); f.start('canceled'); f.end('canceled', 1, 'stopped');
  f.start('finished'); f.end('finished'); f.start('running');
  f.control.receive({ kind: 'runtime-interrupted' }); f.control.receive({ kind: 'runtime-interrupted' });
  assert.deepEqual(f.notices.map(n => [n.sessionId, n.outcome]), [['finished', 'completed'], ['running', 'interrupted']]);
});

test('native notification failure preserves the unread badge', () => {
  const badges: number[] = [];
  const c = new TaskNotifications({ badge: n => badges.push(n), notify() { throw new Error('denied'); }, openSession() {} });
  c.receive({ kind: 'started', sessionId: 'a', turn: 1, title: 'a' });
  c.receive({ kind: 'ended', sessionId: 'a', turn: 1, title: 'a', outcome: 'completed' });
  assert.equal(c.count, 1); assert.deepEqual(badges, [0, 1]);
});

function runtime() {
  const handlers = new Map<string, (...args: any[]) => void>(), events: TaskEvent[] = [];
  let location: { kind: string; path: string } | undefined;
  installTaskNotifications({ on: ((name: string, fn: (...args: any[]) => void) => handlers.set(name, fn)) as any,
    get: ((name: string) => name === 'sessionTitle' ? { get: () => ({ title: 'A\nprivate\ttitle' }) } : { locate: () => location }) as any }, e => events.push(e));
  const session = { id: 'session-a', header: {}, firstLiveSeq: 5 };
  const emit = (type: string, data: any, seq = 10) => handlers.get('session/event')!(session, { type, seq, data });
  const run = (reason: any, step = true, turn = 1) => {
    emit('turn/start', { turn }); if (step) emit('step/start', { turn, step: 0 }); emit('turn/end', { turn, reason });
  };
  return { handlers, session, emit, run, events, locate: (value: typeof location) => { location = value; } };
}

test('actual core event reasons separate completion/errors from cancellation and empty turns', () => {
  const f = runtime();
  const cases = [
    [{ kind: 'completed' }, true, 'completed'], [{ kind: 'completed' }, false, 'stopped'],
    [{ kind: 'error', error: { message: 'do not expose error details' } }, false, 'interrupted'],
    [{ kind: 'max-tokens' }, true, 'interrupted'], [{ kind: 'blocked' }, false, 'stopped'],
    [{ kind: 'aborted', reason: { kind: 'user' } }, true, 'stopped'],
    [{ kind: 'aborted', reason: { kind: 'disposed' } }, true, 'stopped'],
    [{ kind: 'aborted', reason: { kind: 'hook', reason: 'failure' } }, true, 'interrupted'],
  ] as const;
  for (const [reason, step, outcome] of cases) {
    f.run(reason, step); assert.equal((f.events.at(-1) as any).outcome, outcome);
  }
  assert(f.events.every(event => JSON.stringify(event).includes('do not expose') === false));
  assert.equal((f.events[0] as any).title, 'A private title');
});

test('historical ends, seed events and subagent children never create reminders', () => {
  const f = runtime(); f.emit('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
  f.emit('turn/start', { turn: 1 }, 1); assert.equal(f.events.length, 0);
  Object.assign(f.session.header, { origin: 'subagent' }); f.run({ kind: 'completed' }); assert.equal(f.events.length, 0);
  delete (f.session.header as any).origin;
  Object.assign(f.session.header, { parentSession: 'ordinary-fork' }); f.run({ kind: 'completed' }); assert.equal(f.events.length, 2);
});

test('disposal clears an observed active task without a completion reminder', () => {
  const f = runtime(); f.emit('turn/start', { turn: 1 }); f.handlers.get('session/disposed')!(f.session);
  assert.equal((f.events.at(-1) as any).outcome, 'stopped');
  const before = f.events.length; f.handlers.get('session/disposed')!(f.session); assert.equal(f.events.length, before);
});

test('temporary /side ownership markers suppress reminders without hiding ordinary forks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-notification-side-'));
  try {
    const f = runtime(); Object.assign(f.session.header, { parentSession: 'main' });
    f.locate({ kind: 'jsonl', path: join(directory, 'session.v4.jsonl.zstd') });
    writeFileSync(join(directory, '.dsh-side-chat-v2.json'), '{}'); f.run({ kind: 'completed' });
    assert.equal(f.events.length, 0);
    delete (f.session.header as { parentSession?: string }).parentSession;
    Object.assign(f.session.header, { isSeeded: true }); f.run({ kind: 'completed' });
    assert.equal(f.events.length, 0, 'RC ordinary seeded Side forks remain temporary');
    rmSync(join(directory, '.dsh-side-chat-v2.json')); f.run({ kind: 'completed' });
    assert.equal(f.events.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('IPC task packets reject invalid ids, counts, titles, and outcomes', () => {
  const good = { kind: 'ended', sessionId: 'session-a', turn: 0, title: '中文', outcome: 'completed' };
  assert.deepEqual(readTaskEvent(good), good);
  assert.deepEqual(readTaskEvent({ kind: 'runtime-interrupted' }), { kind: 'runtime-interrupted' });
  for (const bad of [null, {}, { ...good, sessionId: '../a' }, { ...good, sessionId: 'a'.repeat(257) }, { ...good, turn: -1 }, { ...good, turn: 0.1 }, { ...good, title: 'x\n' }, { ...good, title: 'x'.repeat(181) }, { ...good, outcome: 'random' }]) assert.equal(readTaskEvent(bad), undefined);
  assert.equal(notificationSessionId('session-123-abc'), true);
});

test('numeric overlays are valid RGBA PNGs with a red circle, transparent corners and white digits', () => {
  for (const count of [1, 12, 99, 100]) {
    const png = notificationBadgePng(count);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 32); assert.equal(png.readUInt32BE(20), 32);
    const compressed: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset), name = png.subarray(offset + 4, offset + 8).toString();
      if (name === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    const pixels = inflateSync(Buffer.concat(compressed));
    assert.equal(pixels.length, 32 * 129);
    assert.equal(pixels[4], 0, 'Top-left corner must remain transparent');
    let red = 0, white = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const index = y * 129 + 1 + x * 4;
      if (pixels[index] === 248 && pixels[index + 1] === 60 && pixels[index + 3] === 255) red++;
      if (pixels[index] === 255 && pixels[index + 1] === 255 && pixels[index + 3] === 255) white++;
    }
    assert(red > 100 && white > 20);
  }
  assert.deepEqual(notificationBadgePng(1000), notificationBadgePng(100));
  assert.notDeepEqual(notificationBadgePng(1), notificationBadgePng(2));
  for (const bad of [0, -1, NaN, 1.5]) assert.throws(() => notificationBadgePng(bad));
});
