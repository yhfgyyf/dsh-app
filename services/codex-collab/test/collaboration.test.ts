import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collaborationFixture } from '../../relay/test/collab-fixture.ts';
import { startService, callConnection } from '../src/daemon.ts';
import { McpClient, fakeOptions, waitFor, runCli } from './helpers.ts';

test('CLI registration and every collaboration phase through real relay HTTP and MCP', { timeout: 30000 }, async () => {
  const relay = await collaborationFixture(), home = await mkdtemp(join(tmpdir(), 'codex-collab-integration-'));
  const running = await startService(home, fakeOptions), mcp = new McpClient(home);
  try {
    assert.equal((await mcp.start()).protocolVersion, '2025-11-25');
    assert.ok((await mcp.request('tools/list')).tools.length >= 40);
    const registration = await runCli(['register', '--home', home, '--relay', relay.origin, '--code-stdin', '--name', 'Codex integration'], relay.code);
    assert.equal(registration.code, 0, registration.error); assert.equal(JSON.parse(registration.out).registered, true);
    assert.ok(!registration.out.includes(relay.code));
    const identity = await mcp.tool('collab_identity'); assert.equal(identity.serverPeer.id, identity.localPeerId); assert.equal(identity.recovery.ready, true);
    const profile = await mcp.tool('collab_profile', { nickname: 'Codex fixture' }); assert.equal(profile.peer.nickname, 'Codex fixture');
    const draft = { body: 'local only' }; await mcp.tool('collab_draft_put', { key: 'new-task', value: draft }); assert.deepEqual(await mcp.tool('collab_draft_get', { key: 'new-task' }), draft);
    const file = await mcp.tool('collab_upload', { operationId: randomUUID(), name: 'context.txt', data: Buffer.from('fixture data').toString('base64') });
    assert.equal(Buffer.from((await mcp.tool('collab_download', { id: file.id })).data, 'base64').toString(), 'fixture data');
    const operationId = randomUUID(), create = { operationId, title: 'Codex integration task', description: 'Demonstrate all collaboration phases', acceptance: 'Evidence and candidate', attachments: [file.id], tags: ['codex-test'] };
    const task = await mcp.tool('collab_create', create); assert.deepEqual(await mcp.tool('collab_create', create), task);
    const catalog = await mcp.tool('collab_catalog', { query: 'Codex integration task' }); assert.ok(catalog.tasks.some((t: any) => t.id === task.id));
    await mcp.tool('collab_follow', { taskId: task.id, following: false }); await mcp.tool('collab_follow', { taskId: task.id, following: true });
    const changed = await mcp.tool('collab_update', { operationId: randomUUID(), taskId: task.id, revision: task.revision, acceptance: 'Updated evidence required' });
    assert.ok(changed.specRevision > task.specRevision); assert.ok((await mcp.tool('collab_history', { taskId: task.id })).revisions.length >= 2);
    const discussion = await mcp.tool('collab_reply', { operationId: randomUUID(), taskId: task.id, kind: 'message', messageType: 'discussion', body: 'A focused question', baseRevision: changed.specRevision });
    const quote = await mcp.tool('collab_reply', { operationId: randomUUID(), taskId: task.id, kind: 'message', messageType: 'progress', body: 'A useful discovery', baseRevision: changed.specRevision, replyTo: discussion.id });
    assert.equal((await mcp.tool('collab_detail', { taskId: task.id })).replies.find((r: any) => r.id === quote.id).replyTo, discussion.id);
    const runId = randomUUID();
    const run = await mcp.tool('collab_start', { operationId: runId, taskId: task.id, mode: 'solve', instruction: 'Use only fixture data', publishMode: 'review', maxTokens: 1000, maxMinutes: 1 });
    await waitFor(() => running.service.runtime.session(run.sessionId).status === 'idle');
    const completed = await mcp.tool('collab_run', { runId });
    assert.equal(completed.status, 'completed'); assert.equal(completed.report.usage.totals.totalTokens, 14); assert.equal(completed.report.client.harness, 'codex');
    assert.equal(completed.submission.files.length, 1); assert.equal(completed.publication, undefined);
    const generated = await mcp.tool('collab_generated_file', { runId, fileId: completed.submission.files[0].id }); assert.equal(Buffer.from(generated.data, 'base64').toString(), '42\n');
    await assert.rejects(() => mcp.tool('collab_reply', { operationId: randomUUID(), taskId: task.id, kind: 'solution', body: 'stale report', runId, reportSnapshot: 'wrong' }), /更新/);
    const candidate = await mcp.tool('collab_reply', { operationId: randomUUID(), taskId: task.id, kind: 'solution', messageType: 'solution', body: 'Reviewed candidate', runId, reportSnapshot: completed.reportSnapshot, generatedFiles: [generated.id], solution: { verification: 'Fixture evidence passed', limitations: 'Deterministic model fixture' } });
    const savedCandidate = (await mcp.tool('collab_candidates', { taskId: task.id })).items[0];
    assert.equal(savedCandidate.solution.report.client.harness, 'codex'); assert.equal(savedCandidate.attachments.length, 1);
    assert.equal(savedCandidate.id, candidate.id);
    const validation = await mcp.tool('collab_validate', { operationId: randomUUID(), taskId: task.id, replyId: candidate.id, baseRevision: changed.specRevision, outcome: 'passed', method: 'Read fixture artifact', environment: 'Isolated local relay', evidence: 'result.txt contains 42' });
    const detail = await mcp.tool('collab_detail', { taskId: task.id });
    const accepted = await mcp.tool('collab_accept', { operationId: randomUUID(), taskId: task.id, replyId: candidate.id, revision: detail.task.revision, validationId: validation.id });
    assert.equal(accepted.status, 'resolved');
    const other = await mcp.tool('collab_create', { operationId: randomUUID(), description: 'Direct completion fixture' });
    assert.equal((await mcp.tool('collab_complete', { operationId: randomUUID(), taskId: other.id, baseRevision: other.specRevision, summary: 'Direct completion verified in isolated fixture' })).status, 'resolved');
    await mcp.tool('collab_sync'); const inbox = await mcp.tool('collab_inbox'); await mcp.tool('collab_read', { through: inbox.cursor });
    assert.equal((await mcp.tool('collab_state')).registered, true);
    assert.equal((await stat(join(home, 'remote-access.json'))).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(JSON.parse(await readFile(join(home, 'remote-access.json'), 'utf8'))).includes('deviceToken'));
    const bad = await fetch(running.connection.origin + '/rpc', { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bearer ' + running.connection.token }, body: '{}' }); assert.equal(bad.status, 403);
  } finally { await mcp.close(); await running.close(); await relay.close(); await rm(home, { recursive: true, force: true }); }
});

test('registration revocation and recovery preserve identity without reusing desktop credentials', { timeout: 15000 }, async () => {
  const relay = await collaborationFixture(), home = await mkdtemp(join(tmpdir(), 'codex-collab-recovery-'));
  const running = await startService(home, fakeOptions), call = (method: string, args = {}) => callConnection(running.connection, method, args);
  try {
    await call('remote/register', { relay: relay.origin, code: relay.code, name: 'Codex recovery test' });
    const id = (await call('collab/identity')).serverPeer.id;
    await call('collab/draft-put', { key: 'preserve', value: { body: 'private draft' } });
    await call('remote/unregister'); assert.equal((await call('collab/state')).registered, false);
    await call('remote/register', { relay: relay.origin, code: relay.relayStore.registration('fixture@example.test'), name: 'Codex recovered' });
    assert.equal((await call('collab/identity')).serverPeer.id, id); assert.equal((await call('collab/draft-get', { key: 'preserve' })).body, 'private draft');
  } finally { await running.close(); await relay.close(); await rm(home, { recursive: true, force: true }); }
});
test('concurrent service starts admit exactly one profile writer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-single-writer-'));
  try {
    const starts = await Promise.allSettled([startService(home, fakeOptions), startService(home, fakeOptions)]);
    assert.equal(starts.filter(r => r.status === 'fulfilled').length, 1);
    for (const result of starts) if (result.status === 'fulfilled') await result.value.close();
    const again = await startService(home, fakeOptions); await again.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});
