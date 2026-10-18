import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collaborationFixture } from '../../relay/test/collab-fixture.ts';
import { startService } from '../src/daemon.ts';
import { fakeOptions, waitFor } from './helpers.ts';

async function fixture() {
  const relay = await collaborationFixture(), home = await mkdtemp(join(tmpdir(), 'codex-continuity-')), running = await startService(home, fakeOptions);
  await running.service.call('remote/register', { relay: relay.origin, code: relay.code, name: 'Codex continuity fixture' });
  const call = running.service.call, monitor = () => (running.service.host as any).exclusive(() => (running.service.host as any).monitor());
  const settle = async (run: any) => { await waitFor(() => running.service.runtime.session(run.sessionId).status === 'idle'); return call('collab/run', { runId: run.id }); };
  return { relay, home, running, call, monitor, settle, close: async () => { await running.close(); await relay.close(); await rm(home, { recursive: true, force: true }); } };
}
test('continuous rounds reuse one session, freeze evidence, retain budgets and stop on shared closure', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), taskId = f.relay.task.id;
    const first = await f.call('collab/start', { operationId: id, taskId, mode: 'solve', instruction: 'CONTINUE_TWICE', publishMode: 'auto', executionMode: 'continuous', maxTokens: 100, maxMinutes: 1 });
    const r1 = await f.settle(first); assert.equal(r1.publication.status, 'published');
    const a = f.running.service.client.data.attempts[id]; assert.equal(a.status, 'working'); assert.equal(a.usedTokens, 14);
    await f.monitor(); assert.equal(a.runIds.length, 2);
    const r2 = await f.settle(f.running.service.client.data.runs[a.runIds[1]]);
    assert.equal(r2.sessionId, r1.sessionId); assert.equal(r2.publication.status, 'published'); assert.equal(a.usedTokens, 28);
    assert.equal((await f.call('collab/run', { runId: r1.id })).reportSnapshot, r1.reportSnapshot);
    assert.equal(await readFile(join(f.home, 'collaboration/workspaces', r1.id, 'result.txt'), 'utf8'), '42\n');
    assert.equal(await readFile(join(f.home, 'collaboration/workspaces', r2.id, 'result.txt'), 'utf8'), '43\n');
    await f.call('collab/attempt-pause', { attemptId: id });
    await f.call('collab/attempt-configure', { attemptId: id, instruction: 'WAIT', executionMode: 'manual', publishMode: 'review' });
    await f.call('collab/attempt-resume', { attemptId: id, nextStep: 'WAIT' });
    assert.equal(a.usedTokens, 28); assert.equal(a.runIds.length, 3);
    const detail = await f.relay.call(0, 'tasks/' + taskId);
    await f.relay.call(0, 'tasks/' + taskId, { operationId: randomUUID(), revision: detail.task.revision, status: 'closed' });
    await f.call('collab/sync'); await f.monitor();
    assert.equal(a.status, 'completed'); await waitFor(() => f.running.service.runtime.session(r1.sessionId).status === 'idle');
    await f.monitor(); assert.equal(a.runIds.length, 3);
  } finally { await f.close(); }
});
test('lost automatic publication response is retried once with the saved operation and attachment', async () => {
  const f = await fixture();
  try {
    const run = await f.call('collab/start', { operationId: randomUUID(), taskId: f.relay.task.id, mode: 'solve', publishMode: 'auto', maxTokens: 100, maxMinutes: 1 });
    await fetch(f.relay.origin + '/__fixture/drop-next-reply', { method: 'POST' });
    const uncertain = await f.settle(run); assert.equal(uncertain.publication.status, 'error');
    const before = await f.call('collab/detail', { taskId: run.taskId }); assert.equal(before.replies.length, 1);
    const confirmed = await f.call('collab/publish-run', { runId: run.id }); assert.equal(confirmed.publication.status, 'published');
    assert.equal(confirmed.publication.operationId, uncertain.publication.operationId);
    assert.equal((await f.call('collab/detail', { taskId: run.taskId })).replies.length, 1); assert.equal(f.relay.stats.attachmentUploads, 1);
  } finally { await f.close(); }
});
test('budget exhaustion and unknown usage halt continuous work without an automatic second round', async () => {
  for (const instruction of ['CONTINUE_TWICE', 'CONTINUE_TWICE NO_USAGE']) {
    const f = await fixture();
    try {
      const run = await f.call('collab/start', { operationId: randomUUID(), taskId: f.relay.task.id, mode: 'solve', instruction, publishMode: 'auto', executionMode: 'continuous', maxTokens: 14, maxMinutes: 0 });
      await f.settle(run); await f.monitor();
      const attempt = f.running.service.client.data.attempts[run.attemptId];
      assert.equal(attempt.status, 'budget'); assert.equal(attempt.desiredState, 'paused'); assert.equal(attempt.runIds.length, 1);
    } finally { await f.close(); }
  }
});
