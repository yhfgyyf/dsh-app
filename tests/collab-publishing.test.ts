import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CollabClient } from '../src/runtime/collab-client.ts';
import { CollabHost } from '../src/runtime/collab-host.ts';
import type { CollabPublishMode } from '../src/shared/collab.ts';

async function fixture(mode: CollabPublishMode) {
  const home = await mkdtemp(join(tmpdir(), 'collab-publishing-')), taskId = randomUUID();
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('Fixture never connects'); } }); await client.restore();
  client.data.settings.publishMode = mode;
  const uploads = new Map<string, any>(), replies = new Map<string, any>();
  let created = 0, posts = 0, loseReply = false, cwd = '', prompt = '', live = true;
  const api = async (path: string, body?: any): Promise<any> => {
    if (path === 'tasks/' + taskId) return { task: { id: taskId, title: 'Fixture', description: 'Explain 42', acceptance: '', revision: 1, specRevision: 1, status: 'open' }, replies: [], attachments: [], attempts: [], validations: [] };
    if (path === 'attachments') { uploads.set(body.operationId, body); return { id: body.operationId }; }
    if (path.endsWith('/replies')) {
      posts++; if (replies.has(body.operationId)) assert.deepEqual(body, replies.get(body.operationId)); else replies.set(body.operationId, structuredClone(body));
      if (loseReply) { loseReply = false; throw new Error('Response lost after commit'); }
      return { id: body.operationId };
    }
    return {};
  };
  client.api = api;
  const ctx: any = { agents: { get: () => ({ status: live ? 'running' : 'idle', cancel: () => { live = false; } }) }, sessionController: {
    create: async (args: any) => { created++; cwd = args.cwd; }, rename: async () => {},
    prompt: async (args: any) => {
      prompt = args.content[0].text;
      await writeFile(join(cwd, 'result.txt'), '42');
      await writeFile(join(cwd, 'submission.json'), JSON.stringify({ body: '# Answer\n\n`42`', verification: 'Fixture assertion passed', limitations: 'No production execution', files: ['result.txt'] }));
      await writeFile(join(cwd, 'continuation.json'), JSON.stringify({ action: 'ready', summary: '42 verified', nextStep: '', wakeOn: [], decisions: [], contribution: { summary: 'New independently checked answer and result file' } }));
    },
    inspect: async (id: string) => ({ meta: { id }, inheritedEventCount: 0, events: [{ type: 'turn/start', data: { turn: 1 } }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Final 42' }] } } }, ...(!live ? [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }] : [])] }),
  }, sessionPersistence: { flush: async () => {}, list: async () => [] } };
  const info = { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' };
  const host = new CollabHost(client, ctx, () => undefined, info);
  const rpc = (method: string, args: object) => host.handle(method, { args }, new AbortController().signal);
  return { home, client, host, taskId, uploads, replies, ctx, api, info, rpc, counts: () => ({ created, posts }), prompt: () => prompt, settle: () => { live = false; }, lose: () => { loseReply = true; }, cleanup: async () => { await host.stop(); await rm(home, { recursive: true, force: true }); } };
}

test('review mode creates editable Markdown and files without publishing; reviewer can remove every AI file', async () => {
  const f = await fixture('review'), runId = randomUUID();
  try {
    assert.equal((await f.rpc('start', { operationId: runId, taskId: f.taskId, mode: 'solve' })).ok, true);
    assert.match(f.prompt(), /GitHub Issue/); assert.match(f.prompt(), /submission.json/); assert.match(f.prompt(), /审核/);
    f.settle(); await f.rpc('run', { runId });
    const run = f.client.data.runs[runId]; assert.equal(run.submission?.files.length, 1); assert.equal(f.replies.size, 0); assert.equal(f.uploads.size, 0);
    const preview = await f.rpc('generated-file', { runId, fileId: run.submission!.files[0].id }); assert.equal(preview.ok, true);
    if (preview.ok) assert.equal(Buffer.from(preview.value.data, 'base64').toString(), '42');
    const sent = await f.rpc('reply', { operationId: randomUUID(), taskId: f.taskId, kind: 'solution', body: 'Reviewed **answer**', runId, reportSnapshot: run.reportSnapshot, generatedFiles: [], attachments: [], solution: { verification: '', limitations: '' } });
    assert.equal(sent.ok, true); assert.equal(f.replies.size, 1); assert.equal(f.uploads.size, 0); assert.ok(run.submittedReplyId);
    const payload = [...f.replies.values()][0]; assert.equal(payload.body, 'Reviewed **answer**'); assert.deepEqual(payload.attachments, []); assert.match(payload.solution.verification, /未单独/);
  } finally { await f.cleanup(); }
});

test('automatic publishing snapshots the chosen mode and retries a lost response after restart with the same payload', async () => {
  const f = await fixture('auto'), runId = randomUUID();
  try {
    await f.rpc('start', { operationId: runId, taskId: f.taskId, mode: 'solve' });
    f.client.data.settings.publishMode = 'manual'; f.lose(); f.settle(); await f.rpc('run', { runId });
    assert.equal(f.client.data.runs[runId].publication?.status, 'error'); assert.equal(f.replies.size, 1); assert.equal(f.uploads.size, 1);
    const unconfirmed = f.client.data.runs[runId];
    const duplicate = await f.rpc('reply', { operationId: randomUUID(), taskId: f.taskId, kind: 'message', body: 'Do not duplicate the unconfirmed post', runId, reportSnapshot: unconfirmed.reportSnapshot });
    assert.equal(duplicate.ok, false); assert.equal(f.counts().posts, 1);
    await f.rpc('run', { runId }); assert.equal(f.counts().posts, 1, 'Read polling must not repeatedly retry a failed publish');
    const restored = new CollabClient(f.home, { isRegistered: () => true, grant: async () => { throw new Error(); } }); await restored.restore(); restored.api = f.api;
    const host = new CollabHost(restored, f.ctx, () => undefined, f.info);
    const retry = () => host.handle('publish-run', { args: { runId } }, new AbortController().signal);
    await retry(); await retry();
    assert.equal(restored.data.runs[runId].publication?.status, 'published'); assert.equal(f.replies.size, 1); assert.equal(f.uploads.size, 1); assert.equal(f.counts().posts, 2);
    const payload = [...f.replies.values()][0]; assert.equal(payload.actor, 'dsh'); assert.match(payload.body, /# Answer/); assert.equal(payload.attachments.length, 1); assert.ok(payload.solution.report);
    await host.stop();
  } finally { await f.cleanup(); }
});

test('manual publishing allows AI generation, and a cancelled automatic run never publishes', async () => {
  const f = await fixture('manual'), runId = randomUUID();
  try {
    assert.equal((await f.rpc('start', { operationId: runId, taskId: f.taskId, mode: 'reply' })).ok, true); assert.equal(f.counts().created, 1);
    f.settle(); await f.rpc('run', { runId });
    assert.ok(f.client.data.runs[runId].submission); assert.equal(f.replies.size, 0); assert.equal(f.uploads.size, 0);
    const cancelledId = randomUUID();
    f.client.data.settings.publishMode = 'auto'; await f.rpc('start', { operationId: cancelledId, taskId: f.taskId, mode: 'reply' }); await f.rpc('cancel', { runId: cancelledId }); await f.rpc('run', { runId: cancelledId });
    assert.equal(f.client.data.runs[cancelledId].status, 'stopped'); assert.equal(f.replies.size, 0); assert.equal(f.uploads.size, 0);
  } finally { await f.cleanup(); }
});

test('startup resumes a completed auto run before its first publish, but never publishes historical runs', async () => {
  const f = await fixture('auto'), runId = randomUUID();
  try {
    await f.rpc('start', { operationId: runId, taskId: f.taskId, mode: 'reply' }); f.settle();
    f.client.data.runs[runId].status = 'completed';
    const legacyId = randomUUID(); f.client.data.runs[legacyId] = { ...f.client.data.runs[runId], id: legacyId, publishMode: undefined };
    await f.client.save(); f.host.start();
    for (let count = 0; count < 100 && f.client.data.runs[runId].publication?.status !== 'published'; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.client.data.runs[runId].publication?.status, 'published'); assert.equal(f.replies.size, 1);
    assert.equal(f.client.data.runs[legacyId].publication, undefined);
  } finally { await f.cleanup(); }
});
