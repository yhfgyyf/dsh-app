import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { CollabClient } from '../src/runtime/collab-client.ts';
import { CollabHost } from '../src/runtime/collab-host.ts';
import { readCheckpoint, taskSnapshot } from '../src/runtime/collab-continuity.ts';
import type { CollabCheckpoint, CollabRun } from '../src/shared/collab.ts';
import type { CollabEvent } from '../services/relay/src/collab-types.ts';

const ready = (decisions: CollabCheckpoint['decisions'] = []): CollabCheckpoint => ({ action: 'ready', summary: 'Verified result', nextStep: '', wakeOn: [], decisions });
const waiting = (): CollabCheckpoint => ({ action: 'wait', summary: 'Waiting for another proposed solution', nextStep: 'Compare new solution with the measured result', wakeOn: ['solution.submitted'], decisions: [] });
const continuing = (): CollabCheckpoint => ({ action: 'continue', summary: 'Measured first case', nextStep: 'Measure a second independent case', wakeOn: [], decisions: [] });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'collab-continuity-')), taskId = randomUUID();
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('Fixture must not connect'); } });
  await client.restore(); client.start();
  client.data.settings = { maxTokens: 5000, maxMinutes: 60, executionMode: 'continuous', publishMode: 'review' };
  const task = { id: taskId, title: 'Public task title', description: 'Compare approaches', acceptance: 'Measured evidence', revision: 1, specRevision: 1, status: 'open', replyCount: 0 };
  const publicUpdates: any[] = [], publications: any[] = [], events: CollabEvent[] = [], replies: any[] = [], validations: any[] = [], calls: string[] = [];
  const attachmentData = new Map<string, Buffer>(), downloaded: string[] = [];
  const artifact = (name: string, bytes: Buffer) => {
    const id = randomUUID(); attachmentData.set(id, bytes);
    return { id, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const sessions = new Map<string, { runId: string; cwd: string; status: 'running' | 'idle'; events: any[] }>();
  let offline = false;
  client.api = async (path: string, body?: any) => {
    if (offline) throw new Error('Offline fixture');
    if (path.startsWith('attachments/')) {
      const id = path.split('/')[1], bytes = attachmentData.get(id); downloaded.push(id);
      if (!bytes) throw new Error('Attachment missing');
      return { data: bytes.toString('base64') };
    }
    if (path.startsWith('sync?')) {
      const after = Number(path.split('=')[1]);
      return { events: events.filter(event => event.id > after), cursor: events.at(-1)?.id ?? 0, unread: events.length, hasMore: false };
    }
    if (path === `tasks/${taskId}/attempts`) { publicUpdates.push(structuredClone(body)); return body; }
    if (path === `tasks/${taskId}/replies` && body) { publications.push(structuredClone(body)); return { id: randomUUID() }; }
    if (path.startsWith(`tasks/${taskId}/replies/`)) {
      const reply = replies.find(reply => reply.id === path.split('/').at(-1));
      if (!reply) throw new Error('Contribution missing');
      return reply;
    }
    if (path.startsWith(`tasks/${taskId}`)) {
      const offset = Number(path.split('offset=')[1] ?? 0);
      return { task: { ...task, replyCount: replies.length }, replies: replies.slice(offset, offset + 50), attachments: [], attempts: [], validations, decision: null, cursor: events.at(-1)?.id ?? 0, hasMore: offset + 50 < replies.length };
    }
    throw new Error('Unexpected fixture path: ' + path);
  };
  const ctx: any = {
    agents: { get: (id: string) => { const session = sessions.get(id); return session && { get status() { return session.status; }, cancel() { session.status = 'idle'; } }; } },
    sessionController: {
      create: async ({ sessionId, cwd }: any) => { sessions.set(sessionId, { runId: '', cwd, status: 'running', events: [] }); },
      rename: async () => {},
      prompt: async ({ sessionId, requestId }: any) => {
        calls.push(requestId); const session = sessions.get(sessionId)!; session.runId = requestId;
        session.events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 0 } },
          { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'Phase result' }] } } }];
        await writeFile(join(session.cwd, 'submission.json'), JSON.stringify({ body: 'Public phase result', verification: 'Fixture measurement', limitations: 'No production execution', files: [] }));
      },
      inspect: async (id: string) => ({ meta: { id }, inheritedEventCount: 0, events: sessions.get(id)!.events }),
    },
    sessionPersistence: { flush: async () => {}, list: async () => [] },
  };
  const info = { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' };
  const derive = () => ({ uncachedInputTokens: 200, outputTokens: 40, totalTokens: 240 });
  let host = new CollabHost(client, ctx, derive, info);
  const rpc = (method: string, args: object = {}) => host.handle(method, { args }, new AbortController().signal);
  const start = async (args: object = {}) => { const result = await rpc('start', { operationId: randomUUID(), taskId, mode: 'solve', instruction: 'Private local exploration direction', ...args }); assert.equal(result.ok, true, JSON.stringify(result)); return result.ok ? result.value as CollabRun : null!; };
  const settle = async (run: CollabRun, checkpoint?: CollabCheckpoint) => {
    const session = sessions.get(run.sessionId)!; session.status = 'idle';
    session.events.push({ type: 'step/end', data: { turn: 1, step: 0 } }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
    if (checkpoint) await writeFile(join(session.cwd, 'continuation.json'), JSON.stringify(checkpoint));
    const result = await rpc('run', { runId: run.id }); assert.equal(result.ok, true, JSON.stringify(result));
  };
  const enqueue = (kind = 'solution.submitted') => {
    const replyId = randomUUID(), event: CollabEvent = { id: (events.at(-1)?.id ?? 0) + 1, taskId, actorId: 'other-peer', kind, subjectId: replyId, at: Date.now() };
    events.push(event); replies.push({ id: replyId, taskId, authorId: 'other-peer', actor: 'user', kind: kind === 'solution.submitted' ? 'solution' : 'message', body: 'New measured counterexample', baseRevision: 1, replaces: null, createdAt: event.at, solution: null, attachments: [] });
    return event;
  };
  return { home, taskId, task, client, calls, publicUpdates, publications, events, replies, validations, sessions, rpc, start, settle, enqueue, artifact, attachmentData, downloaded,
    tick: async () => { await (host as any).monitor(); },
    offline: (value: boolean) => { offline = value; },
    restart: async () => { await host.stop(); const restored = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error(); } }); await restored.restore(); restored.api = client.api; restored.start(); host = new CollabHost(restored, ctx, derive, info); return restored; },
    cleanup: async () => { await host.stop(); await rm(home, { recursive: true, force: true }); } };
}

test('continuous stages use new sessions, retain prior artifacts and pause a repeated step without new evidence', async () => {
  const f = await fixture();
  try {
    const first = await f.start(), attempt = f.client.data.attempts[first.attemptId!];
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(f.publicUpdates).includes('Private local'), false, 'Private instructions must not escape in public attempt metadata');
    await f.settle(first, continuing()); await f.tick();
    assert.equal(f.calls.length, 2); assert.equal(attempt.runIds.length, 2);
    const second = f.client.data.runs[attempt.activeRunId!]; assert.notEqual(second.sessionId, first.sessionId);
    const request = JSON.parse(await readFile(join(f.sessions.get(second.sessionId)!.cwd, 'task.json'), 'utf8'));
    assert.equal(request.previousRuns[0].id, first.id); assert.equal(request.remainingTokens, 4760);
    await f.settle(second, continuing()); await f.tick();
    assert.equal(f.calls.length, 2); assert.equal(attempt.status, 'paused'); assert.match(attempt.waitReason, /空转/);
    assert.equal(attempt.usedTokens, 480); await f.rpc('run', { runId: second.id }); assert.equal(attempt.usedTokens, 480);
  } finally { await f.cleanup(); }
});

test('only matching wait conditions wake an attempt and all supplied events require explicit decisions', async () => {
  const f = await fixture();
  try {
    const first = await f.start(), attempt = f.client.data.attempts[first.attemptId!];
    await f.settle(first, waiting()); const note = f.enqueue('reply.created'); await f.client.sync(); await f.tick();
    assert.equal(f.calls.length, 1); assert.equal(attempt.reviewedCursor, 0); assert.equal(attempt.pendingEvents.length, 1);
    const solution = f.enqueue(); await f.client.sync(); await f.tick();
    assert.equal(f.calls.length, 2); const second = f.client.data.runs[attempt.activeRunId!];
    assert.deepEqual(second.triggerEventIds, [note.id, solution.id]);
    const request = JSON.parse(await readFile(join(f.sessions.get(second.sessionId)!.cwd, 'task.json'), 'utf8'));
    assert.ok(request.discussion.some((reply: any) => reply.id === solution.subjectId && reply.authorId === 'other-peer' && reply.body.includes('counterexample')));
    await f.settle(second, ready([{ eventId: note.id, decision: 'defer', reason: 'Needs more evidence' }, { eventId: solution.id, decision: 'verify', reason: 'Counterexample checked' }]));
    assert.equal(attempt.status, 'ready'); assert.equal(attempt.pendingEvents.length, 0); assert.equal(attempt.reviewedCursor, solution.id); assert.equal(attempt.decisions.length, 2);
  } finally { await f.cleanup(); }
});

test('paused attempts keep new information across restart and only explicit resume launches another phase', async () => {
  const f = await fixture();
  try {
    const run = await f.start(), attemptId = run.attemptId!; await f.settle(run, waiting());
    assert.equal((await f.rpc('attempt-pause', { attemptId })).ok, true);
    const event = f.enqueue(); await f.client.sync(); await f.tick(); assert.equal(f.calls.length, 1);
    const restored = await f.restart(); await f.tick();
    assert.equal(restored.data.attempts[attemptId].desiredState, 'paused'); assert.equal(restored.data.attempts[attemptId].pendingEvents[0].id, event.id); assert.equal(f.calls.length, 1);
    assert.equal((await f.rpc('attempt-resume', { attemptId, nextStep: 'Verify the new counterexample' })).ok, true); assert.equal(f.calls.length, 2);
    const active = restored.data.attempts[attemptId].activeRunId!;
    await f.rpc('cancel', { runId: active }); assert.equal(restored.data.attempts[attemptId].desiredState, 'paused'); await f.tick(); assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test('cumulative budget cannot be reset by another run or bare resume', async () => {
  const f = await fixture();
  try {
    const first = await f.start({ maxTokens: 240, maxMinutes: 0 }), attempt = f.client.data.attempts[first.attemptId!];
    await f.settle(first, continuing()); await f.tick();
    assert.equal(attempt.usedTokens, 240); assert.equal(attempt.status, 'budget'); assert.equal(f.calls.length, 1);
    assert.equal((await f.rpc('attempt-resume', { attemptId: attempt.id })).ok, false);
    assert.equal((await f.rpc('attempt-resume', { attemptId: attempt.id, additionalTokens: 500, nextStep: 'Verify the second case' })).ok, true);
    assert.equal(attempt.limits.maxTokens, 740); assert.equal(f.calls.length, 2);
    await f.settle(f.client.data.runs[attempt.activeRunId!], ready());
    assert.equal(attempt.usedTokens, 480); assert.equal(attempt.status, 'ready');
  } finally { await f.cleanup(); }
});

test('missing checkpoints and task closure stop continuous work without inventing a next phase', async () => {
  const f = await fixture();
  try {
    const missing = await f.start(); await f.settle(missing); await f.tick();
    assert.equal(f.client.data.attempts[missing.attemptId!].status, 'paused'); assert.equal(f.calls.length, 1);
    const active = await f.start(); f.task.status = 'closed';
    await f.tick(); assert.equal(f.calls.length, 2); assert.equal(f.client.data.runs[active.id].status, 'running', 'External task changes wait for the phase checkpoint');
    await f.settle(active, continuing()); await f.tick();
    assert.equal(f.client.data.attempts[active.attemptId!].status, 'completed'); assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test('offline checkpoints do not launch a phase and a pause retains its exact public retry operation', async () => {
  const f = await fixture();
  try {
    const run = await f.start(), attempt = f.client.data.attempts[run.attemptId!];
    await f.settle(run, continuing()); f.offline(true); await f.tick(); assert.equal(f.calls.length, 1);
    await f.rpc('attempt-pause', { attemptId: attempt.id }); const update = structuredClone(attempt.publicUpdate!);
    await f.tick(); assert.deepEqual(attempt.publicUpdate, update); assert.equal(attempt.desiredState, 'paused');
    const stored = JSON.parse(await readFile(join(f.home, 'collaboration', 'profile.json'), 'utf8'));
    assert.deepEqual(stored.attempts[attempt.id].publicUpdate, update);
    f.offline(false); await f.tick(); assert.equal(attempt.publicUpdate, undefined); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.publicUpdates.at(-1), update.payload);
  } finally { await f.cleanup(); }
});

test('waiting and submitted attempts observe task completion without a matching wake condition or a model call', async () => {
  const f = await fixture();
  try {
    const first = await f.start(), firstAttempt = f.client.data.attempts[first.attemptId!];
    await f.settle(first, waiting()); firstAttempt.wakeOn = ['reply.created'];
    const second = await f.start(), secondAttempt = f.client.data.attempts[second.attemptId!];
    await f.settle(second, ready()); secondAttempt.status = 'submitted';
    f.task.status = 'resolved'; f.enqueue('solution.accepted'); await f.client.sync(); await f.tick();
    assert.equal(firstAttempt.status, 'completed'); assert.equal(secondAttempt.status, 'completed'); assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test('new counterevidence reopens evaluation of a continuous candidate while preserving its original result', async () => {
  const f = await fixture();
  try {
    const first = await f.start(), attempt = f.client.data.attempts[first.attemptId!];
    await f.settle(first, ready()); assert.equal(attempt.status, 'ready');
    const event = f.enqueue('reply.created'); await f.client.sync(); await f.tick();
    assert.equal(f.calls.length, 2); const second = f.client.data.runs[attempt.activeRunId!];
    assert.deepEqual(second.triggerEventIds, [event.id]); assert.equal(f.client.data.runs[first.id].checkpoint?.action, 'ready');
    const input = JSON.parse(await readFile(join(f.sessions.get(second.sessionId)!.cwd, 'task.json'), 'utf8'));
    assert.match(input.instruction, /既有候选/);
    await f.settle(second, { ...waiting(), decisions: [{ eventId: event.id, decision: 'reject', reason: 'Does not change the measured case' }] });
    await f.tick(); assert.equal(f.calls.length, 2); assert.equal(attempt.status, 'waiting');
  } finally { await f.cleanup(); }
});

test('a checkpoint from the old journal cannot consume a reused event id after relay reset', async () => {
  const f = await fixture();
  try {
    const first = await f.start(), attempt = f.client.data.attempts[first.attemptId!];
    await f.settle(first, waiting()); const old = f.enqueue(); await f.client.sync(); await f.tick();
    const active = f.client.data.runs[attempt.activeRunId!]; assert.deepEqual(active.triggerEventIds, [old.id]);
    attempt.eventEpoch = (attempt.eventEpoch ?? 0) + 1; attempt.desiredState = 'paused'; attempt.status = 'paused';
    const replacement = { ...old, subjectId: randomUUID(), actorId: 'replacement-peer' };
    attempt.pendingEvents = [replacement]; attempt.reviewedCursor = 0; attempt.decisions = [];
    await f.settle(active, ready([{ eventId: old.id, decision: 'adopt', reason: 'Old evidence was checked' }]));
    assert.deepEqual(attempt.pendingEvents, [replacement]); assert.equal(attempt.reviewedCursor, 0); assert.equal(attempt.decisions.length, 0);
    assert.equal(attempt.desiredState, 'paused'); assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test('restart completes a persisted review-stage checkpoint without replaying its model request', async () => {
  const f = await fixture();
  try {
    const run = await f.start(); await f.settle(run, ready());
    const savedRun = f.client.data.runs[run.id], attempt = f.client.data.attempts[run.attemptId!];
    // Simulate an atomic client save occurring after settlement but before checkpoint handling.
    savedRun.checkpointHandled = false; savedRun.checkpoint = undefined;
    attempt.activeRunId = run.id; attempt.status = 'working'; await f.client.save();
    const restored = await f.restart(); await f.tick();
    assert.equal(restored.data.runs[run.id].checkpointHandled, true);
    assert.equal(restored.data.attempts[attempt.id].status, 'ready'); assert.equal(restored.data.attempts[attempt.id].activeRunId, undefined);
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('task snapshots page beyond fifty replies and fetch a required contribution outside the bounded pages', async () => {
  const taskId = randomUUID(), peerId = randomUUID(), paths: string[] = [];
  const replies = Array.from({ length: 620 }, (_, index) => ({ id: 'reply-' + index, authorId: peerId, baseRevision: 3, attachments: [{ id: 'artifact-' + index }], body: 'Evidence ' + index }));
  const event: CollabEvent = { id: 42, taskId, actorId: peerId, subjectId: 'reply-555', kind: 'solution.submitted', at: 1 };
  const snapshot = await taskSnapshot(async path => {
    paths.push(path); if (path.endsWith('/replies/reply-555')) return replies[555];
    const offset = Number(path.split('offset=')[1] ?? 0);
    return { task: { id: taskId, revision: 3, specRevision: 3, replyCount: replies.length }, replies: replies.slice(offset, offset + 50), hasMore: offset + 50 < replies.length };
  }, taskId, [event]);
  assert.ok(snapshot.replies.some(reply => reply.id === 'reply-619')); assert.ok(snapshot.replies.some(reply => reply.id === 'reply-51'));
  assert.deepEqual(snapshot.replies.find(reply => reply.id === 'reply-555'), replies[555]);
  assert.ok(paths.includes(`tasks/${taskId}/replies/reply-555`)); assert.match(snapshot.discussionNotice, /未包含/); assert.deepEqual(snapshot.unavailableEventIds, []);
});

test('checkpoint validation rejects an empty next step and unreviewed trigger events', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'collab-checkpoint-'));
  try {
    await writeFile(join(cwd, 'continuation.json'), JSON.stringify({ ...continuing(), nextStep: '' }));
    await assert.rejects(readCheckpoint(cwd, []), /具体下一步/);
    await writeFile(join(cwd, 'continuation.json'), JSON.stringify(ready()));
    await assert.rejects(readCheckpoint(cwd, [1]), /未记录处理决定/);
    await writeFile(join(cwd, 'continuation.json'), JSON.stringify({ ...waiting(), wakeOn: [] }));
    await assert.rejects(readCheckpoint(cwd, []), /唤醒条件/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('candidate artifacts enter the local inputs with verified bytes and contribution provenance', async () => {
  const f = await fixture();
  try {
    const source = f.enqueue(), bytes = Buffer.from('candidate artifact evidence\n'), file = f.artifact('measurement.csv', bytes);
    f.replies[0].attachments.push(file);
    const run = await f.start(), cwd = f.sessions.get(run.sessionId)!.cwd;
    const request = JSON.parse(await readFile(join(cwd, 'task.json'), 'utf8'));
    const attachment = request.discussion.find((reply: any) => reply.id === source.subjectId).attachments[0];
    assert.equal(attachment.sourceReplyId, source.subjectId); assert.equal(attachment.sha256, file.sha256);
    assert.match(attachment.path, /^inputs\//); assert.equal(attachment.availability, 'downloaded');
    assert.deepEqual(await readFile(join(cwd, attachment.path)), bytes); assert.deepEqual(f.downloaded, [file.id]);
    assert.match(request.attachmentNotice, /不代表.*验证/);
  } finally { await f.cleanup(); }
});

test('a missing or corrupt contribution artifact prevents the model from starting', async () => {
  for (const failure of ['missing', 'corrupt']) {
    const f = await fixture();
    try {
      f.enqueue(); const file = f.artifact('evidence.txt', Buffer.from('expected')); f.replies[0].attachments.push(file);
      if (failure === 'missing') f.attachmentData.delete(file.id); else f.attachmentData.set(file.id, Buffer.from('modified'));
      const id = randomUUID(), result = await f.rpc('start', { operationId: id, taskId: f.taskId, mode: 'solve' });
      assert.equal(result.ok, false); assert.equal(f.calls.length, 0);
      assert.equal(f.client.data.runs[id].status, 'error'); assert.equal(f.client.data.attempts[id].desiredState, 'paused');
      if (!result.ok) assert.match(result.error.message, /附件/);
    } finally { await f.cleanup(); }
  }
});

test('pending contribution artifacts take priority and skipped attachments carry explicit limits', async () => {
  const f = await fixture();
  try {
    f.enqueue(); const prior = f.replies[0];
    prior.attachments = Array.from({ length: 8 }, (_, index) => f.artifact(`candidate-${index}.txt`, Buffer.from('candidate ' + index)));
    const first = await f.start(); await f.settle(first, { ...waiting(), wakeOn: ['reply.created'] }); f.downloaded.length = 0;
    const event = f.enqueue('reply.created'), urgent = f.artifact('counterexample.txt', Buffer.from('pending evidence'));
    f.replies.at(-1)!.attachments.push(urgent); await f.client.sync(); await f.tick();
    const attempt = f.client.data.attempts[first.attemptId!], run = f.client.data.runs[attempt.activeRunId!], cwd = f.sessions.get(run.sessionId)!.cwd;
    const request = JSON.parse(await readFile(join(cwd, 'task.json'), 'utf8'));
    assert.equal(f.downloaded.length, 8); assert.equal(f.downloaded[0], urgent.id);
    const pending = request.discussion.find((reply: any) => reply.id === event.subjectId).attachments[0]; assert.equal(pending.availability, 'downloaded');
    const skipped = request.discussion.find((reply: any) => reply.id === prior.id).attachments.filter((file: any) => !file.path);
    assert.equal(skipped.length, 1); assert.equal(skipped[0].availability, 'limit'); assert.match(skipped[0].note, /未下载.*未验证/);
    assert.match(request.attachmentNotice, /8.*64 MiB/);
  } finally { await f.cleanup(); }
});

test('validation events fetch their candidate beyond bounded pages and prioritize its evidence over eight old attachments', async () => {
  const f = await fixture();
  try {
    f.enqueue('reply.created');
    const earlier = f.replies[0];
    earlier.attachments = Array.from({ length: 8 }, (_, index) => f.artifact(`earlier-${index}.txt`, Buffer.from(`earlier evidence ${index}`)));
    for (let index = 1; index <= 650; index++) f.replies.push({ ...earlier, id: randomUUID(), body: `Discussion ${index}`, attachments: [] });
    const candidate = f.replies[550], evidence = f.artifact('candidate-under-validation.csv', Buffer.from('candidate evidence'));
    candidate.kind = 'solution'; candidate.body = 'Candidate outside both the bounded first pages and latest page'; candidate.attachments = [evidence];
    const first = await f.start();
    assert.equal(f.downloaded.length, 8); assert.equal(f.downloaded.includes(evidence.id), false);
    await f.settle(first, { ...waiting(), wakeOn: ['validation.created'] }); f.downloaded.length = 0;
    const validationId = randomUUID();
    f.validations.push({ id: validationId, taskId: f.taskId, replyId: candidate.id, authorId: 'other-peer', baseRevision: 1, candidateDigest: 'fixture-digest', outcome: 'failed', method: 'Rerun candidate', environment: 'Fixture', evidence: 'New counterexample', createdAt: Date.now() });
    const event: CollabEvent = { id: f.events.at(-1)!.id + 1, taskId: f.taskId, actorId: 'other-peer', kind: 'validation.created', subjectId: validationId, at: Date.now() };
    f.events.push(event); await f.client.sync(); await f.tick();
    const attempt = f.client.data.attempts[first.attemptId!], review = f.client.data.runs[attempt.activeRunId!], cwd = f.sessions.get(review.sessionId)!.cwd;
    const request = JSON.parse(await readFile(join(cwd, 'task.json'), 'utf8'));
    const received = request.discussion.find((reply: any) => reply.id === candidate.id);
    assert.ok(received, 'The validation candidate is fetched directly although its discussion page is omitted');
    assert.equal(f.downloaded[0], evidence.id); assert.equal(f.downloaded.length, 8);
    assert.equal(received.attachments[0].sourceReplyId, candidate.id); assert.equal(received.attachments[0].availability, 'downloaded');
    assert.deepEqual(await readFile(join(cwd, received.attachments[0].path)), Buffer.from('candidate evidence'));
    assert.equal(request.discussion.find((reply: any) => reply.id === earlier.id).attachments.filter((file: any) => file.availability === 'limit').length, 1);
    assert.deepEqual(review.triggerEventIds, [event.id]);
  } finally { await f.cleanup(); }
});

test('only an explicit public direction is shared while local instructions remain private', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    assert.equal(f.publicUpdates.at(-1).direction, '');
    assert.notEqual(f.publicUpdates.at(-1).direction, f.task.title);
    await f.rpc('attempt-pause', { attemptId: first.attemptId });
    const next = await f.start({ publicDirection: 'Reproduce on Linux independently' });
    assert.equal(f.publicUpdates.at(-1).direction, 'Reproduce on Linux independently');
    assert.match(f.client.data.attempts[next.attemptId!].direction, /Private local/);
    assert.equal(JSON.stringify(f.publicUpdates).includes('Private local'), false);
  } finally { await f.cleanup(); }
});

test('automatic evaluation without a new contribution stays local and still consumes its event decisions', async () => {
  const f = await fixture();
  try {
    const first = await f.start({ publishMode: 'auto' }), attempt = f.client.data.attempts[first.attemptId!];
    await f.settle(first, ready());
    assert.equal(f.publications.length, 0); assert.match(first.publicationSkipReason!, /未声明/);
    const update = f.enqueue('reply.created'); await f.client.sync(); await f.tick();
    const review = f.client.data.runs[attempt.activeRunId!];
    await f.settle(review, { ...waiting(), decisions: [{ eventId: update.id, decision: 'reject', reason: 'Acknowledged; no new evidence changes the candidate' }] });
    await f.tick();
    assert.equal(attempt.pendingEvents.length, 0); assert.equal(attempt.reviewedCursor, update.id);
    assert.equal(attempt.decisions.length, 1); assert.equal(f.publications.length, 0); assert.equal(f.calls.length, 2);
    assert.match(review.publicationSkipReason!, /未声明/);
    await f.rpc('publish-run', { runId: review.id }); assert.equal(f.publications.length, 0);
  } finally { await f.cleanup(); }
});

test('automatic publishing suppresses repeated content and revisions replace the previous candidate', async () => {
  const f = await fixture();
  try {
    const first = await f.start({ publishMode: 'auto' }), attempt = f.client.data.attempts[first.attemptId!];
    await f.settle(first, { ...ready(), contribution: { summary: 'Initial measured candidate' } });
    assert.equal(f.publications.length, 1); assert.equal(f.publications[0].kind, 'solution');
    const originalId = first.publication!.replyId;
    const event = f.enqueue('reply.created'); await f.client.sync(); await f.tick();
    const duplicate = f.client.data.runs[attempt.activeRunId!];
    assert.equal(duplicate.replacesReplyId, originalId);
    await f.settle(duplicate, { ...ready([{ eventId: event.id, decision: 'reject', reason: 'Candidate unchanged' }]), contribution: { summary: 'A rewritten declaration does not change the output' } });
    assert.equal(f.publications.length, 1); assert.match(duplicate.publicationSkipReason!, /重复/);
    const secondEvent = f.enqueue('reply.created'); await f.client.sync(); await f.tick();
    const revision = f.client.data.runs[attempt.activeRunId!];
    await writeFile(join(f.sessions.get(revision.sessionId)!.cwd, 'submission.json'), JSON.stringify({ body: 'A changed candidate handles the counterexample', verification: 'Both measurements pass', limitations: '', files: [] }));
    await f.settle(revision, { ...ready([{ eventId: secondEvent.id, decision: 'verify', reason: 'Counterexample reproduced and fixed' }]), contribution: { summary: 'New fix and confirming measurements' } });
    assert.equal(f.publications.length, 2); assert.equal(f.publications[1].replaces, originalId);
    assert.equal(attempt.candidateReplyId, revision.publication!.replyId);
    assert.notEqual(attempt.candidateReplyId, originalId);
  } finally { await f.cleanup(); }
});

test('an exact copy of a received contribution does not echo back to other nodes', async () => {
  const f = await fixture();
  try {
    f.enqueue('reply.created'); f.replies[0].body = 'Public phase result';
    const run = await f.start({ publishMode: 'auto' });
    await f.settle(run, { ...waiting(), contribution: { summary: 'Claims to contribute the same text' } });
    assert.equal(f.publications.length, 0); assert.match(run.publicationSkipReason!, /重复/);
    await f.tick(); assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('a manual candidate and its revision provide the next run with the current replacement target', async () => {
  const f = await fixture();
  try {
    const first = await f.start(), attempt = f.client.data.attempts[first.attemptId!];
    await f.settle(first, ready());
    const sent = await f.rpc('reply', { operationId: randomUUID(), taskId: f.taskId, kind: 'solution', body: 'Human checked candidate', runId: first.id, reportSnapshot: first.reportSnapshot, generatedFiles: [], attachments: [], solution: { verification: 'Human test', limitations: '' } });
    assert.equal(sent.ok, true); assert.equal(attempt.candidateReplyId, first.submittedReplyId);
    const changed = await f.rpc('reply', { operationId: randomUUID(), taskId: f.taskId, kind: 'solution', body: 'Edited candidate', replaces: first.submittedReplyId, baseRevision: 1, solution: { verification: 'Retest', limitations: '' } });
    assert.equal(changed.ok, true); if (!changed.ok) return;
    assert.equal(attempt.candidateReplyId, changed.value.id);
    await f.rpc('attempt-resume', { attemptId: attempt.id, nextStep: 'Recheck after another input' });
    const run = f.client.data.runs[attempt.activeRunId!];
    assert.equal(run.replacesReplyId, changed.value.id);
  } finally { await f.cleanup(); }
});

test('publishing uncertainty waits for an idempotent retry before scheduling another stage', async () => {
  const f = await fixture();
  try {
    const first = await f.start({ publishMode: 'auto' }), attempt = f.client.data.attempts[first.attemptId!];
    const api = f.client.api.bind(f.client); let lose = true;
    f.client.api = async (path, body) => { if (path.endsWith('/replies') && body && lose) { lose = false; throw new Error('Response lost'); } return api(path, body); };
    await f.settle(first, { ...continuing(), contribution: { summary: 'First measured stage' } });
    assert.equal(first.publication?.status, 'error');
    await f.tick(); assert.equal(f.calls.length, 1);
    assert.equal((await f.rpc('publish-run', { runId: first.id })).ok, true);
    await f.tick(); assert.equal(f.calls.length, 2); assert.equal(attempt.runIds.length, 2);
  } finally { await f.cleanup(); }
});

test('manual resume cannot change authorization or fork a candidate after a lost publication response', async () => {
  const f = await fixture();
  try {
    const first = await f.start({ publishMode: 'auto' }), attempt = f.client.data.attempts[first.attemptId!];
    await f.settle(first, { ...ready(), contribution: { summary: 'Initial measured candidate' } });
    const originalId = attempt.candidateReplyId;
    const event = f.enqueue('reply.created'); await f.client.sync(); await f.tick();
    const revision = f.client.data.runs[attempt.activeRunId!];
    await writeFile(join(f.sessions.get(revision.sessionId)!.cwd, 'submission.json'), JSON.stringify({ body: 'A changed candidate', verification: 'Counterexample passes', limitations: '', files: [] }));
    const api = f.client.api.bind(f.client), committed = new Map<string, any>(); let lose = true;
    f.client.api = async (path, body: any) => {
      if (path.endsWith('/replies') && body) {
        if (!committed.has(body.operationId)) committed.set(body.operationId, await api(path, body));
        if (lose) { lose = false; throw new Error('Response lost after commit'); }
        return committed.get(body.operationId);
      }
      return api(path, body);
    };
    await f.settle(revision, { ...ready([{ eventId: event.id, decision: 'verify', reason: 'New counterexample checked' }]), contribution: { summary: 'Updated candidate with new evidence' } });
    assert.equal(revision.publication?.status, 'error'); assert.equal(f.publications.length, 2);
    assert.equal(attempt.candidateReplyId, originalId, 'The unconfirmed remote candidate ID is not guessed locally');
    const before = structuredClone(attempt), runIds = Object.keys(f.client.data.runs), calls = f.calls.length;
    const resume = await f.rpc('attempt-resume', { attemptId: attempt.id, nextStep: 'Another independent check', additionalTokens: 500, additionalMinutes: 5 });
    assert.equal(resume.ok, false); if (!resume.ok) assert.match(resume.error.message, /先重试自动发布并确认结果/);
    assert.deepEqual(attempt, before, 'Reject before changing limits, nextStep, desiredState, or public status');
    assert.deepEqual(Object.keys(f.client.data.runs), runIds); assert.equal(f.calls.length, calls);
    const operationId = revision.publication!.operationId;
    assert.equal((await f.rpc('publish-run', { runId: revision.id })).ok, true);
    assert.equal(revision.publication!.operationId, operationId); assert.equal(f.publications.length, 2, 'Retry recovers exactly the committed candidate');
    assert.equal(attempt.candidateReplyId, committed.get(operationId).id);
    assert.equal((await f.rpc('attempt-resume', { attemptId: attempt.id, nextStep: 'Another independent check', additionalTokens: 500, additionalMinutes: 5 })).ok, true);
    assert.equal(f.calls.length, calls + 1);
    assert.equal(attempt.limits.maxTokens, before.limits.maxTokens + 500); assert.equal(attempt.limits.maxMinutes, before.limits.maxMinutes + 5);
    assert.equal(f.client.data.runs[attempt.activeRunId!].replacesReplyId, committed.get(operationId).id);
  } finally { await f.cleanup(); }
});

test('malformed contribution declarations cannot authorize automatic publishing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'collab-contribution-'));
  try {
    await writeFile(join(cwd, 'continuation.json'), JSON.stringify({ ...ready(), contribution: { summary: ' ' } }));
    await assert.rejects(readCheckpoint(cwd, []), /invalid_text/);
    await writeFile(join(cwd, 'continuation.json'), JSON.stringify({ ...ready(), contribution: true }));
    await assert.rejects(readCheckpoint(cwd, []), /invalid_object/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
