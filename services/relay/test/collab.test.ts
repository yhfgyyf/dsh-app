import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { PrivateStore } from '../src/private-store.js';
import { createPrivateRelay } from '../src/private-server.js';
import { CollabStore } from '../src/collab-store.js';
import { createCollabServer, relayAuthorizer } from '../src/collab-server.js';
import { issueCollabGrant, verifyCollabGrant } from '../src/collab-auth.js';
import { emptyCounts } from '../src/collab-types.js';

const secret = 'collab-fixture-secret-at-least-32-bytes';
const operation = () => ({ operationId: randomUUID() });
async function fixture() {
  const relayStore = new PrivateStore(':memory:'), store = new CollabStore(':memory:');
  relayStore.provision('collab@example.test', 'fixture-password-long');
  const devices = [0, 1, 2].map(i => relayStore.register(relayStore.registration('collab@example.test'), 'peer-' + i)!);
  const relay = createPrivateRelay(relayStore, 'http://127.0.0.1:8787', { collabSecret: secret });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const relayOrigin = `http://127.0.0.1:${(relay.server.address() as any).port}`;
  const app = createCollabServer(store, relayAuthorizer(relayOrigin, secret));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
  async function grant(device: typeof devices[number]) {
    const res = await fetch(relayOrigin + '/v1/collab-token', { method: 'POST', headers: { authorization: 'Bearer ' + device.deviceToken }, body: JSON.stringify({ deviceId: device.deviceId }) });
    assert.equal(res.status, 200); return (await res.json()).token as string;
  }
  const tokens = await Promise.all(devices.map(grant));
  async function call(token: string, path: string, body?: unknown) {
    const res = await fetch(origin + '/collab/v1/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  }
  const peers = await Promise.all(tokens.map((token, i) => call(token, 'join', { id: randomUUID(), nickname: '同名节点' }).then(r => { assert.equal(r.status, 200); return r.body; })));
  return { relayStore, store, relayOrigin, origin, devices, tokens, peers, call, close: async () => { await app.close(); await relay.close(); store.db.close(); relayStore.db.close(); } };
}

test('grants are scoped, authenticated and expire', () => {
  const grant = issueCollabGrant({ kind: 'desktop', deviceId: 'device-fixture', role: 'control' }, secret, 1000);
  assert.equal(verifyCollabGrant(grant.token, secret, 2000).deviceId, 'device-fixture');
  assert.throws(() => verifyCollabGrant(grant.token + 'x', secret, 2000));
  assert.throws(() => verifyCollabGrant(grant.token, secret, 301000));
  assert.throws(() => issueCollabGrant({ kind: 'desktop', deviceId: 'device-fixture', role: 'control' }, 'short'));
});

test('three peers publish, read, follow, reply, solve and author-accept with durable, idempotent events', async () => {
  const f = await fixture(); const [a, b, c] = f.tokens;
  try {
    const create = { ...operation(), title: '复现问题', description: '最小复现', acceptance: '检查通过', tags: ['测试'] };
    const made = await f.call(a, 'tasks', create); assert.equal(made.status, 200); const task = made.body;
    assert.deepEqual((await f.call(a, 'tasks', create)).body, task);
    assert.equal((await f.call(a, 'tasks', { ...create, title: '篡改重试' })).status, 409);
    assert.equal((await f.call(b, 'tasks/' + task.id)).body.task.title, create.title);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM collab_participants').get().n, 0, 'reading never starts work');
    await f.call(c, `tasks/${task.id}/follow`, { following: true });
    await f.call(b, `tasks/${task.id}/participate`, { ...operation(), status: 'working' });
    const reply = { ...operation(), kind: 'message', actor: 'user', body: '需要补充版本', baseRevision: 1 };
    assert.equal((await f.call(b, `tasks/${task.id}/replies`, reply)).status, 200);
    await f.call(b, `tasks/${task.id}/replies`, reply);
    const solution = { ...operation(), kind: 'solution', actor: 'dsh', body: '执行修复步骤', baseRevision: 1,
      solution: { verification: 'mock check passed', limitations: '隔离验证', report: { runId: randomUUID(), startedAt: 10, finishedAt: 20,
        client: { appVersion: 'fixture', runtimeVersion: 'fixture', pluginVersion: '0.1.0', platform: 'linux', arch: 'x64' },
        usage: { status: 'unavailable', source: 'client-runtime', totals: emptyCounts(), routes: [], sessions: 1, attempts: 0 } } } };
    const solved = await f.call(b, `tasks/${task.id}/replies`, solution); assert.equal(solved.status, 200);
    const detail = (await f.call(c, 'tasks/' + task.id)).body;
    assert.equal(detail.task.status, 'open'); assert.equal(detail.replies.length, 2);
    assert.equal(detail.replies[1].solution.report.usage.totals.outputTokens, null);
    const validation = await f.call(c, `tasks/${task.id}/validations`, { ...operation(), replyId: solved.body.id, baseRevision: detail.task.specRevision, outcome: 'passed', method: 'Run the isolated check', environment: 'Three-peer fixture', evidence: 'The expected output matched' });
    assert.equal(validation.status, 200);
    const accept = { ...operation(), replyId: solved.body.id, revision: detail.task.revision, validationId: validation.body.id };
    assert.equal((await f.call(b, `tasks/${task.id}/accept`, accept)).status, 403);
    assert.equal((await f.call(a, `tasks/${task.id}/accept`, accept)).body.status, 'resolved');
    const accepted = (await f.call(a, `tasks/${task.id}`)).body;
    assert.equal(accepted.decision.validationId, validation.body.id);
    assert.equal(accepted.decision.authorId, f.peers[0].id);
    assert.equal(accepted.decision.candidateDigest, validation.body.candidateDigest);
    assert.equal((await f.call(c, 'inbox')).body.items[0].kind, 'solution.accepted');
    assert.equal((await f.call(b, 'tasks?view=participating')).body.tasks.length, 0, 'legacy participation and replies do not start an exploration');
    const sync = (await f.call(c, 'sync?after=0')).body;
    assert.equal(new Set(sync.events.map((e: any) => e.id)).size, sync.events.length);
    await f.call(c, 'inbox/read', { through: sync.cursor });
    assert.equal((await f.call(c, 'inbox')).body.unread, 0);
    assert.equal((await f.call(c, 'sync?after=' + sync.cursor)).body.events.length, 0);
  } finally { await f.close(); }
});

test('phone reads collaboration while desktop has no tunnel; revoke and unregister deny all data', async () => {
  const f = await fixture();
  try {
    const bound = f.relayStore.bind(f.devices[0].deviceId, 'phone')!;
    const res = await fetch(f.relayOrigin + '/v1/collab-token', { method: 'POST', headers: { authorization: 'Bearer ' + bound.bindingToken }, body: JSON.stringify({ bindingId: bound.bindingId }) });
    const token = (await res.json()).token;
    assert.equal((await f.call(token, 'tasks')).status, 200);
    assert.equal((await f.call(token, 'tasks', { ...operation(), title: 'denied', description: 'denied' })).status, 403);
    f.relayStore.revoke(f.devices[0].deviceId, bound.bindingId);
    assert.equal((await f.call(token, 'tasks')).status, 403);
    f.relayStore.db.prepare('DELETE FROM remote_devices WHERE id = ?').run(f.devices[1].deviceId);
    assert.equal((await f.call(f.tokens[1], 'me')).status, 403);
  } finally { await f.close(); }
});

test('attachment drafts are private, publish links grant access, names and quotas are bounded', async () => {
  const f = await fixture();
  try {
    const upload = await f.call(f.tokens[0], 'attachments', { ...operation(), name: 'result.txt', data: Buffer.from('result').toString('base64') });
    assert.equal(upload.status, 200); const id = upload.body.id;
    assert.equal((await f.call(f.tokens[1], 'attachments/' + id)).status, 404);
    assert.equal((await f.call(f.tokens[1], 'tasks', { ...operation(), title: 'steal', description: 'draft', attachments: [id] })).status, 403);
    assert.equal((await f.call(f.tokens[0], 'tasks', { ...operation(), title: 'publish', description: 'selected file', attachments: [id] })).status, 200);
    assert.equal((await f.call(f.tokens[1], 'attachments/' + id)).body.data, Buffer.from('result').toString('base64'));
    assert.equal((await f.call(f.tokens[0], 'attachments', { ...operation(), name: '../secret', data: 'YQ==' })).status, 400);
  } finally { await f.close(); }
});

test('WebSocket invalidations require authentication, and data survive a database reopen', async () => {
  const f = await fixture();
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/collab/v1/events');
  try {
    await once(socket, 'open');
    const frames: any[] = []; socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
    socket.send(JSON.stringify({ type: 'auth', token: f.tokens[0] }));
    await once(socket, 'message');
    const event = new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('missing invalidation')), 3000); socket.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.type === 'changed' && m.cursor > 0) { clearTimeout(timer); resolve(m); } }); });
    await f.call(f.tokens[1], 'tasks', { ...operation(), title: 'new', description: 'new task' });
    assert.ok((await event).cursor > 0);
    const dir = mkdtempSync(join(tmpdir(), 'dsh-collab-')); const file = join(dir, 'collab.sqlite');
    try { await f.store.db.backup(file); const reopened = new CollabStore(file); try { assert.equal(reopened.catalog(f.peers[0], {}).tasks.length, 1); } finally { reopened.db.close(); } }
    finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { socket.terminate(); await f.close(); }
});

test('task-scoped reads, bounded reply pages and optimistic revision history preserve other work', async () => {
  const f = await fixture();
  try {
    const [a, b] = f.peers;
    const first = f.store.createTask(a, { ...operation(), title: 'First', description: 'original' });
    const second = f.store.createTask(a, { ...operation(), title: 'Second', description: 'other' });
    for (let i = 0; i < 52; i++) f.store.addReply(b, first.id, { ...operation(), kind: 'message', actor: 'user', body: String(i), baseRevision: 1 });
    f.store.addReply(b, second.id, { ...operation(), kind: 'message', actor: 'user', body: 'keep unread', baseRevision: 1 });
    const page1 = (await f.call(f.tokens[0], 'tasks/' + first.id)).body;
    const page2 = (await f.call(f.tokens[0], 'tasks/' + first.id + '?offset=50')).body;
    assert.equal(page1.replies.length, 50); assert.equal(page1.hasMore, true); assert.equal(page2.replies.length, 2);
    assert.equal(new Set([...page1.replies, ...page2.replies].map((r: any) => r.id)).size, 52);
    await f.call(f.tokens[0], 'inbox/read', { taskId: first.id, through: page1.cursor });
    assert.equal(f.store.unread(a), 1);
    const edit = { ...operation(), revision: 1, description: 'new requirements' };
    assert.equal((await f.call(f.tokens[0], 'tasks/' + first.id, edit)).body.revision, 2);
    assert.equal((await f.call(f.tokens[0], 'tasks/' + first.id, { ...edit, ...operation() })).status, 409);
    const revisions = (await f.call(f.tokens[1], `tasks/${first.id}/history`)).body.revisions;
    assert.deepEqual(revisions.map((r: any) => r.description), ['new requirements', 'original']);
  } finally { await f.close(); }
});

test('maximum-size attachments avoid regex overflow and CLI backups include bytes without replacing files', async () => {
  const f = await fixture(), dir = mkdtempSync(join(tmpdir(), 'collab-backup-'));
  try {
    const encoded = Buffer.alloc(8 * 1024 * 1024, 65).toString('base64');
    const file = f.store.upload(f.peers[0], { ...operation(), name: 'large.bin', data: encoded });
    assert.equal(file.size, 8 * 1024 * 1024);
    assert.throws(() => f.store.upload(f.peers[0], { ...operation(), name: 'invalid.bin', data: 'YR==' }), /invalid_attachment/);
    const dbPath = join(dir, 'live.sqlite'), backup = join(dir, 'backup.sqlite'); await f.store.db.backup(dbPath);
    const cli = fileURLToPath(new URL('../dist/collab-admin.js', import.meta.url));
    const env = { ...process.env, COLLAB_DB_PATH: dbPath };
    assert.match(execFileSync(process.execPath, [cli, 'backup', backup], { env, encoding: 'utf8' }), /Verified SQLite backup/);
    assert.throws(() => execFileSync(process.execPath, [cli, 'backup', backup], { env, stdio: 'pipe' }), /Command failed/);
    const restored = new CollabStore(backup);
    try { assert.equal(restored.download(f.peers[0], file.id).sha256, file.sha256); assert.equal(restored.download(f.peers[0], file.id).data.length, encoded.length); }
    finally { restored.db.close(); }
    execFileSync(process.execPath, [cli, 'ban-peer', f.peers[0].id, 'fixture moderation'], { env, stdio: 'pipe' });
    const moderated = new CollabStore(dbPath);
    try { assert.equal((moderated.db.prepare('SELECT banned FROM collab_peers WHERE id = ?').get(f.peers[0].id) as any).banned, 1); }
    finally { moderated.db.close(); }
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('collaboration validation has its own rate bucket and cannot exhaust the remote-control heartbeat budget', async () => {
  const f = await fixture();
  try {
    for (let batch = 0; batch < 24; batch++) {
      const statuses = await Promise.all(Array.from({ length: 50 }, async () => {
        const response = await fetch(f.relayOrigin + '/v1/collab-validate', { method: 'POST', headers: { authorization: 'Bearer ' + f.tokens[0] }, body: '{}' });
        await response.arrayBuffer(); return response.status;
      }));
      assert.ok(statuses.every(s => s === 200));
    }
    const health = await fetch(f.relayOrigin + '/health'); assert.equal(health.status, 200); await health.arrayBuffer();
  } finally { await f.close(); }
});

test('independent attempts persist each owner, pause and budget state with idempotent contribution events', async () => {
  const f = await fixture(); const [a, b, c] = f.tokens;
  try {
    const task = (await f.call(a, 'tasks', { ...operation(), title: 'Independent exploration', description: 'Preserve each direction' })).body;
    const path = `tasks/${task.id}/attempts`, first = { ...operation(), id: randomUUID(), baseRevision: 1, status: 'working', direction: 'Reproduce the issue', nextStep: 'Check the failure' };
    const second = { ...operation(), id: randomUUID(), baseRevision: 1, status: 'working', direction: 'Compare another approach' };
    assert.equal((await f.call(b, path, first)).status, 200);
    const cursor = f.store.cursor();
    assert.equal((await f.call(b, path, first)).status, 200); assert.equal(f.store.cursor(), cursor);
    assert.equal((await f.call(c, path, { ...first, ...operation() })).status, 403);
    assert.equal((await f.call(b, path, second)).status, 200);
    const remote = { ...operation(), id: randomUUID(), baseRevision: 1, status: 'waiting', direction: 'Remote reproduction', waitReason: 'Need a sample', nextStep: 'Retry with sample' };
    assert.equal((await f.call(c, path, remote)).status, 200);
    for (const status of ['waiting', 'ready', 'paused', 'budget', 'error']) {
      assert.equal((await f.call(b, path, { ...operation(), id: first.id, baseRevision: 1, status })).body.status, status);
    }
    const paused = { ...operation(), id: first.id, baseRevision: 1, status: 'paused' };
    await f.call(b, path, paused);
    const message = { ...operation(), actor: 'dsh', kind: 'message', body: 'A counterexample changes the next step', baseRevision: 1, attemptId: remote.id };
    assert.equal((await f.call(b, `tasks/${task.id}/replies`, message)).status, 403);
    const reply = await f.call(c, `tasks/${task.id}/replies`, message); assert.equal(reply.status, 200);
    const detail = (await f.call(a, `tasks/${task.id}`)).body;
    assert.equal(detail.attempts.length, 3);
    assert.equal(detail.attempts.find((v: any) => v.id === first.id).status, 'paused', 'new contributions cannot resume another attempt');
    assert.equal(detail.attempts.find((v: any) => v.id === second.id).status, 'working');
    assert.equal(detail.participants.find((v: any) => v.peerId === f.peers[1].id).status, 'working', 'one paused direction does not hide another active direction');
    assert.equal(detail.replies[0].attemptId, remote.id);
    const fromFirst = (await f.call(b, `tasks/${task.id}/replies`, { ...message, ...operation(), attemptId: first.id })).body;
    const fromSecond = (await f.call(b, `tasks/${task.id}/replies`, { ...message, ...operation(), attemptId: second.id })).body;
    const manual = (await f.call(b, `tasks/${task.id}/replies`, { ...message, ...operation(), actor: 'user', attemptId: null })).body;
    const events = (await f.call(a, 'sync?after=0')).body.events;
    assert.ok(events.some((v: any) => v.kind === 'reply.created' && v.subjectId === reply.body.id));
    assert.ok(events.some((v: any) => v.kind === 'attempt.updated' && v.subjectId === first.id));
    assert.equal(events.find((v: any) => v.subjectId === fromFirst.id).sourceAttemptId, first.id);
    assert.equal(events.find((v: any) => v.subjectId === fromSecond.id).sourceAttemptId, second.id);
    assert.equal(events.find((v: any) => v.subjectId === manual.id).sourceAttemptId, null);
    const inbox = (await f.call(a, 'inbox')).body.items;
    assert.equal(inbox.find((v: any) => v.subjectId === fromSecond.id).sourceAttemptId, second.id);
    assert.equal(inbox.find((v: any) => v.subjectId === manual.id).sourceAttemptId, null);
    const direct = await f.call(a, `tasks/${task.id}/replies/${reply.body.id}`);
    assert.equal(direct.status, 200); assert.equal(direct.body.body, message.body); assert.equal(direct.body.attemptId, remote.id);
    const otherTask = (await f.call(a, 'tasks', { ...operation(), title: 'Another task', description: 'Scope boundary' })).body;
    assert.equal((await f.call(a, `tasks/${otherTask.id}/replies/${reply.body.id}`)).status, 404);
    await f.call(a, `tasks/${task.id}`, { ...operation(), revision: task.revision, status: 'closed' });
    assert.equal((await f.call(b, path, { ...operation(), id: second.id, baseRevision: 1, status: 'completed' })).status, 200);
    assert.equal((await f.call(b, path, { ...operation(), id: first.id, baseRevision: 1, status: 'withdrawn' })).status, 200);
    assert.equal((await f.call(b, path, { ...operation(), id: second.id, baseRevision: 1, status: 'working' })).status, 409);
    assert.equal((await f.call(b, path, { ...operation(), id: randomUUID(), baseRevision: 1, status: 'working' })).status, 409);
    const dir = mkdtempSync(join(tmpdir(), 'collab-attempts-'));
    try {
      const file = join(dir, 'attempts.sqlite'); await f.store.db.backup(file); const reopened = new CollabStore(file);
      try { assert.equal(reopened.detail(f.peers[0], task.id).attempts.find(v => v.id === remote.id)?.waitReason, 'Need a sample'); }
      finally { reopened.db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { await f.close(); }
});

test('acceptance requires current unchanged candidate evidence, rejects stale, replaced and failed verification', async () => {
  const f = await fixture(); const [a, b, c] = f.tokens;
  try {
    const task = (await f.call(a, 'tasks', { ...operation(), title: 'Verified acceptance', description: 'Original goal', acceptance: 'The check passes' })).body;
    const path = `tasks/${task.id}`;
    const candidate = async (token = b, extra = {}) => f.call(token, path + '/replies', { ...operation(), actor: 'user', kind: 'solution', body: 'The proposed change', baseRevision: 1, solution: { verification: 'Claim only', limitations: 'Fixture' }, ...extra });
    const verify = async (replyId: string, extra = {}, token = c) => f.call(token, path + '/validations', { ...operation(), replyId, baseRevision: 1, outcome: 'passed', method: 'Execute isolated test', environment: 'Fixture v1', evidence: 'Exit 0, expected output', ...extra });
    const original = (await candidate()).body.id;
    assert.equal((await f.call(a, path + '/accept', { ...operation(), replyId: original, revision: 1 })).status, 400, 'a submitter claim alone is insufficient');
    const failed = (await verify(original, { outcome: 'failed' })).body;
    assert.equal((await f.call(a, path + '/accept', { ...operation(), replyId: original, revision: 1, validationId: failed.id })).status, 409);
    const inconclusive = (await verify(original, { outcome: 'inconclusive' })).body;
    assert.equal((await f.call(a, path + '/accept', { ...operation(), replyId: original, revision: 1, validationId: inconclusive.id })).status, 409);
    const passing = await verify(original); assert.equal(passing.status, 200); assert.match(passing.body.candidateDigest, /^[a-f0-9]{64}$/);
    const replaced = (await candidate(b, { replaces: original })).body.id;
    assert.equal((await f.call(a, path + '/accept', { ...operation(), replyId: original, revision: 1, validationId: passing.body.id })).body.error, 'solution_replaced');
    assert.equal((await verify(original)).body.error, 'solution_replaced');
    assert.equal((await f.call(a, path + '/accept', { ...operation(), replyId: replaced, revision: 1, validationId: passing.body.id })).status, 409, 'verification is bound to exactly one candidate');
    const replacementEvidence = (await verify(replaced)).body;
    const updated = (await f.call(a, path, { ...operation(), revision: 1, description: 'A new acceptance target' })).body;
    assert.equal(updated.specRevision, 2); assert.equal(updated.revision, 2);
    assert.equal((await f.call(a, path + '/accept', { ...operation(), replyId: replaced, revision: 2, validationId: replacementEvidence.id })).body.error, 'valid_verification_required');
    assert.equal((await verify(replaced)).body.error, 'task_changed');
    assert.equal((await verify(replaced, { baseRevision: 2 })).status, 200, 'an existing candidate can be explicitly reverified against current requirements');
    const current = (await candidate(a, { baseRevision: 2 })).body.id;
    const evidenceBody = { ...operation(), replyId: current, baseRevision: 2, outcome: 'passed', method: 'Author reran test', environment: 'Fixture v2', evidence: 'Updated assertions all passed' };
    const evidence = await f.call(a, path + '/validations', evidenceBody); assert.equal(evidence.status, 200);
    const cursor = f.store.cursor(); assert.deepEqual((await f.call(a, path + '/validations', evidenceBody)).body, evidence.body); assert.equal(f.store.cursor(), cursor);
    const tagged = (await f.call(a, path, { ...operation(), revision: 2, tags: ['verified'] })).body;
    assert.equal(tagged.revision, 3); assert.equal(tagged.specRevision, 2, 'administrative metadata does not invalidate evidence');
    const accept = { ...operation(), replyId: current, revision: 3, validationId: evidence.body.id };
    assert.equal((await f.call(b, path + '/accept', accept)).status, 403);
    const accepted = await f.call(a, path + '/accept', accept); assert.equal(accepted.status, 200); assert.equal(accepted.body.status, 'resolved');
    assert.equal(accepted.body.specRevision, 2); assert.equal(accepted.body.revision, 4);
    assert.deepEqual((await f.call(a, path + '/accept', accept)).body, accepted.body);
    assert.equal((await f.call(a, path)).body.decision.evidence, evidenceBody.evidence);
    const reopened = (await f.call(a, path, { ...operation(), revision: 4, acceptance: 'An additional check is required' })).body;
    assert.equal(reopened.status, 'open'); assert.equal(reopened.specRevision, 3); assert.equal(reopened.acceptedReplyId, null);
    assert.equal((await f.call(a, path)).body.decision, null);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM collab_acceptances').get().n, 1, 'reopening preserves the prior decision for audit');
  } finally { await f.close(); }
});

test('only requirement changes advance specRevision, with attachment versions preserved in history', async () => {
  const f = await fixture(); const [a] = f.peers;
  try {
    const task = f.store.createTask(a, { ...operation(), title: 'Version rules', description: 'Original' });
    const update = (revision: number, extra: unknown) => f.store.updateTask(a, task.id, { ...operation(), revision, ...extra as object });
    assert.equal(update(1, { status: 'closed' }).specRevision, 1);
    assert.equal(update(2, { status: 'open' }).specRevision, 1);
    assert.equal(update(3, { description: 'Original', tags: ['triage'] }).specRevision, 1);
    assert.equal(update(4, { title: 'Refined goal' }).specRevision, 2);
    const file = f.store.upload(a, { ...operation(), name: 'requirements.txt', data: Buffer.from('Required input').toString('base64') });
    assert.equal(update(5, { attachments: [file.id] }).specRevision, 3);
    assert.equal(update(6, { attachments: [file.id] }).specRevision, 3);
    assert.equal(update(7, { attachments: [] }).specRevision, 4);
    const revisions = f.store.history(a, task.id, 0).revisions;
    assert.equal(revisions.find((r: any) => r.revision === 6).attachments[0].sha256, file.sha256);
    assert.equal(revisions.find((r: any) => r.revision === 8).attachments.length, 0);
    assert.throws(() => f.store.addReply(a, task.id, { ...operation(), kind: 'message', actor: 'user', body: 'Bad requirement version', baseRevision: 8 }), /task_changed/, 'CAS revisions cannot be substituted for requirement revisions');
  } finally { await f.close(); }
});

test('cross-page replacements remain visible and explicit current-version verification can accept an older candidate', async () => {
  const f = await fixture(); const [a, b] = f.peers;
  try {
    const task = f.store.createTask(a, { ...operation(), title: 'Reverify existing work', description: 'Initial requirement' });
    const solution = { actor: 'user', kind: 'solution', body: 'Candidate output', baseRevision: 1, solution: { verification: 'Initial check', limitations: '' } };
    const old = f.store.addReply(b, task.id, { ...operation(), ...solution });
    for (let i = 0; i < 51; i++) f.store.addReply(a, task.id, { ...operation(), actor: 'user', kind: 'message', body: `Discussion ${i}`, baseRevision: 1 });
    const replacement = f.store.addReply(b, task.id, { ...operation(), ...solution, replaces: old.id });
    const page = f.store.detail(a, task.id);
    assert.equal(page.replies[0].supersededBy, replacement.id);
    assert.equal(f.store.reply(a, task.id, old.id).supersededBy, replacement.id);
    assert.ok(!page.replies.some(r => r.id === replacement.id), 'replacement is on another page');
    const attempt = f.store.attempt(b, task.id, { ...operation(), id: randomUUID(), baseRevision: 1, status: 'ready' });
    f.store.updateTask(a, task.id, { ...operation(), revision: 1, acceptance: 'Also satisfies the new requirement' });
    const validation = f.store.validate(a, task.id, { ...operation(), replyId: replacement.id, baseRevision: 2, candidateDigest: 'untrusted-client-digest', outcome: 'passed', method: 'Rerun with new requirement', environment: 'Fixture', evidence: 'Both old and new checks pass' });
    assert.notEqual(validation.candidateDigest, 'untrusted-client-digest');
    assert.equal(f.store.accept(a, task.id, { ...operation(), replyId: replacement.id, revision: 2, validationId: validation.id }).status, 'resolved');
    assert.equal(f.store.attempt(b, task.id, { ...operation(), id: attempt.id, baseRevision: 1, status: 'completed' }).status, 'completed');
    assert.throws(() => f.store.attempt(b, task.id, { ...operation(), id: attempt.id, baseRevision: 1, status: 'working' }), /task_not_open/);
    const resolved = f.store.detail(a, task.id);
    assert.equal(resolved.decision?.baseRevision, 2); assert.equal(resolved.validations[0].baseRevision, 2);
    f.store.db.prepare('UPDATE collab_tasks SET hidden = 1 WHERE id = ?').run(task.id);
    assert.throws(() => f.store.reply(b, task.id, replacement.id), /task_not_found/, 'direct reads preserve moderation visibility');
  } finally { await f.close(); }
});

test('exploration catalog requires an owned attempt and filters active and ended attempts', async () => {
  const f = await fixture(); const [a, b, c] = f.peers;
  try {
    const make = (title: string, peer = a) => f.store.createTask(peer, { ...operation(), title, description: 'Catalog fixture' });
    const attempt = (taskId: string, status: string, peer = b) => f.store.attempt(peer, taskId, { ...operation(), id: randomUUID(), baseRevision: 1, status });
    make('Only authored', b);
    const followed = make('Only followed'); f.store.setFollow(b, followed.id, { following: true });
    const commented = make('Only discussed'); f.store.addReply(b, commented.id, { ...operation(), actor: 'user', kind: 'message', body: 'A question', baseRevision: 1 });
    attempt(commented.id, 'working', c);
    const legacy = make('Legacy participant'); f.store.participate(b, legacy.id, { ...operation(), status: 'working' });
    const manual = make('Manual candidate'); f.store.addReply(b, manual.id, { ...operation(), actor: 'user', kind: 'solution', body: 'Manual proposal', baseRevision: 1, solution: { verification: 'Fixture', limitations: '' } });
    const active = ['working', 'waiting', 'ready', 'paused', 'budget', 'submitted', 'error'].map(status => { const task = make(status); attempt(task.id, status); return task.id; });
    const ended = ['withdrawn', 'completed'].map(status => { const task = make(status); attempt(task.id, status); return task.id; });
    attempt(active[0], 'completed');
    const ids = async (query = '') => (await f.call(f.tokens[1], 'tasks?view=participating' + query)).body.tasks.map((t: any) => t.id).sort();
    assert.deepEqual(await ids(), [...active, ...ended].sort());
    assert.deepEqual(await ids('&explorationStatus=active'), [...active].sort());
    assert.deepEqual(await ids('&explorationStatus=history'), [...ended, active[0]].sort(), 'a task can have both active and ended directions');
    assert.equal((await f.call(f.tokens[1], 'tasks?view=participating&explorationStatus=unknown')).status, 400);
  } finally { await f.close(); }
});

test('candidate index spans discussion pages and event subjects locate their actual discussion page', async () => {
  const f = await fixture(); const [a, b] = f.peers;
  try {
    const task = f.store.createTask(a, { ...operation(), title: 'Candidate index', description: 'Initial requirement' });
    const path = `tasks/${task.id}`;
    const attempt = f.store.attempt(b, task.id, { ...operation(), id: randomUUID(), baseRevision: 1, status: 'ready' });
    const solution = { actor: 'dsh', kind: 'solution', body: 'Candidate output', baseRevision: 1, attemptId: attempt.id, solution: { verification: 'Fixture check', limitations: 'Fixture only' } };
    const original = f.store.addReply(b, task.id, { ...operation(), ...solution });
    for (let i = 0; i < 51; i++) f.store.addReply(a, task.id, { ...operation(), actor: 'user', kind: 'message', body: `Discussion ${i}`, baseRevision: 1 });
    const attachment = f.store.upload(b, { ...operation(), name: 'result.txt', data: Buffer.from('result').toString('base64') });
    const replacement = f.store.addReply(b, task.id, { ...operation(), ...solution, replaces: original.id, attachments: [attachment.id] });
    const extra = Array.from({ length: 50 }, () => f.store.addReply(b, task.id, { ...operation(), ...solution, attemptId: null }));
    f.store.updateTask(a, task.id, { ...operation(), revision: 1, acceptance: 'Reverification required' });
    const first = await f.call(f.tokens[0], path + '/candidates');
    assert.equal(first.status, 200); assert.equal(first.body.total, 51); assert.equal(first.body.items.length, 50); assert.equal(first.body.hasMore, true);
    assert.equal(first.body.items[0].id, replacement.id); assert.equal(first.body.items[0].replaces, original.id); assert.equal(first.body.items[0].supersededBy, null);
    assert.equal(first.body.items[0].baseRevision, 1, 'unreplaced older requirements remain available for explicit reverification');
    assert.equal(first.body.items[0].attemptId, attempt.id); assert.equal(first.body.items[0].attachments[0].sha256, attachment.sha256);
    assert.equal(first.body.items[0].solution.verification, solution.solution.verification);
    const second = (await f.call(f.tokens[0], path + '/candidates?offset=50')).body;
    assert.equal(second.total, 51); assert.equal(second.hasMore, false); assert.deepEqual(second.items.map((r: any) => r.id), [extra.at(-1)!.id]);
    assert.ok(![...first.body.items, ...second.items].some((r: any) => r.id === original.id));
    const detail = (await f.call(f.tokens[0], path)).body;
    assert.equal(detail.task.solutionCount, 51); assert.equal(detail.replies[0].supersededBy, replacement.id); assert.equal(detail.replyOffset, 0);
    const byReply = (await f.call(f.tokens[0], path + '?subjectId=' + replacement.id)).body;
    assert.equal(byReply.replyOffset, 50); assert.ok(byReply.replies.some((r: any) => r.id === replacement.id));
    const validation = f.store.validate(a, task.id, { ...operation(), replyId: extra.at(-1)!.id, baseRevision: 2, outcome: 'passed', method: 'Run fixture', environment: 'Fixture', evidence: 'Checks passed' });
    const byValidation = (await f.call(f.tokens[0], path + '?subjectId=' + validation.id)).body;
    assert.equal(byValidation.replyOffset, 100); assert.ok(byValidation.replies.some((r: any) => r.id === validation.replyId));
    assert.equal((await f.call(f.tokens[0], path + '?offset=50')).body.replyOffset, 50);
    for (const subjectId of [task.id, attempt.id]) assert.equal((await f.call(f.tokens[0], path + '?offset=50&subjectId=' + subjectId)).body.replyOffset, 0);
    assert.equal((await f.call(f.tokens[0], path + '?subjectId=' + randomUUID())).body.error, 'subject_not_found');
    const other = f.store.createTask(a, { ...operation(), title: 'Another task', description: 'Subject boundary' });
    assert.equal((await f.call(f.tokens[0], `tasks/${other.id}?subjectId=${validation.id}`)).body.error, 'subject_not_found');
    assert.equal((await f.call(f.tokens[0], `tasks/${other.id}?subjectId=${replacement.id}`)).body.error, 'subject_not_found');
    f.store.db.prepare('UPDATE collab_tasks SET hidden = 1 WHERE id = ?').run(task.id);
    assert.equal((await f.call(f.tokens[0], path + '/candidates')).status, 404);
    assert.equal((await f.call(f.tokens[0], path + '?subjectId=' + replacement.id)).status, 404);
  } finally { await f.close(); }
});

test('selective inbox reads affect only the requesting peer and explicit events', async () => {
  const f = await fixture(); const [a, b, c] = f.peers;
  try {
    const task = f.store.createTask(a, { ...operation(), title: 'Precise read state', description: 'Inbox fixture' });
    for (const peer of [b, c]) f.store.setFollow(peer, task.id, { following: true });
    const reply = (taskId: string, peer = a) => f.store.addReply(peer, taskId, { ...operation(), actor: 'user', kind: 'message', body: 'Unread contribution', baseRevision: 1 });
    reply(task.id); const first = f.store.cursor();
    reply(task.id); const second = f.store.cursor();
    const other = f.store.createTask(c, { ...operation(), title: 'Other inbox', description: 'Peer boundary' });
    reply(other.id); const foreign = f.store.cursor();
    const marked = await f.call(f.tokens[1], 'inbox/read', { eventIds: [second, second, foreign], through: foreign });
    assert.equal(marked.status, 200); assert.equal(marked.body.unread, 1, 'eventIds take precedence over bulk through');
    assert.equal(f.store.inbox(b).items.find(e => e.id === first)?.read, false);
    assert.equal(f.store.inbox(b).items.find(e => e.id === second)?.read, true);
    assert.equal(f.store.inbox(c).items.find(e => e.id === second)?.read, false);
    assert.equal(f.store.inbox(c).items.find(e => e.id === foreign)?.read, false, 'another peer inbox cannot be marked');
    assert.equal((await f.call(f.tokens[1], 'inbox/read', { eventIds: [] })).body.unread, 1);
    for (const eventIds of [[0], [-1], ['1'], [1.5], Array(201).fill(first), 'invalid']) assert.equal((await f.call(f.tokens[1], 'inbox/read', { eventIds })).status, 400);
    assert.equal(f.store.unread(b), 1, 'invalid input does not mark earlier events');
    assert.equal((await f.call(f.tokens[1], 'inbox/read', { through: foreign, taskId: task.id })).body.unread, 0);
    assert.equal((await f.call(f.tokens[2], 'inbox/read', { through: foreign, taskId: task.id })).body.unread, 1, 'legacy task-scoped bulk reads remain supported');
    assert.equal((await f.call(f.tokens[2], 'inbox/read', { through: foreign })).body.unread, 0);
  } finally { await f.close(); }
});

test('legacy SQLite migration retains replies, attachment bytes and revisions while normalizing review tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-migration-')), file = join(dir, 'legacy.sqlite');
  try {
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE collab_peers (id TEXT PRIMARY KEY, device TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, createdAt INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE collab_tasks (id TEXT PRIMARY KEY, authorId TEXT NOT NULL REFERENCES collab_peers(id), title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL, tags TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, acceptedReplyId TEXT, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE collab_replies (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES collab_tasks(id), authorId TEXT NOT NULL REFERENCES collab_peers(id), actor TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, baseRevision INTEGER NOT NULL, replaces TEXT REFERENCES collab_replies(id), createdAt INTEGER NOT NULL, solution TEXT);
      CREATE TABLE collab_events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL REFERENCES collab_tasks(id), actorId TEXT NOT NULL REFERENCES collab_peers(id), kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE collab_attachments (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES collab_peers(id), name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE collab_attachment_links (attachmentId TEXT NOT NULL REFERENCES collab_attachments(id), taskId TEXT NOT NULL REFERENCES collab_tasks(id), replyId TEXT NOT NULL DEFAULT '', PRIMARY KEY(attachmentId, taskId, replyId));
      INSERT INTO collab_peers VALUES ('legacy-peer', 'legacy-device', 'Existing user', 1, 0);
      INSERT INTO collab_tasks VALUES ('legacy-task', 'legacy-peer', 'Existing task', 'Preserve this requirement', 'Existing criterion', '[]', 'review', 7, 1, 2, NULL, 0);
      INSERT INTO collab_replies VALUES ('legacy-reply', 'legacy-task', 'legacy-peer', 'user', 'solution', 'Existing candidate', 7, NULL, 2, '{"verification":"Existing check","limitations":"","report":null}');
      INSERT INTO collab_events(taskId, actorId, kind, at) VALUES ('legacy-task', 'legacy-peer', 'solution.submitted', 2);
    `);
    legacy.prepare('INSERT INTO collab_attachments VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy-file', 'legacy-peer', 'existing.txt', 3, 'old-hash', Buffer.from('old'), 1);
    legacy.prepare('INSERT INTO collab_attachment_links VALUES (?, ?, ?)').run('legacy-file', 'legacy-task', 'legacy-reply');
    legacy.close();
    for (let pass = 0; pass < 2; pass++) {
      const migrated = new CollabStore(file), peer = { id: 'legacy-peer', nickname: 'Existing user', createdAt: 1 };
      try {
        const detail = migrated.detail(peer, 'legacy-task');
        assert.equal(detail.task.status, 'open'); assert.equal(detail.task.revision, 7); assert.equal(detail.task.specRevision, 7);
        assert.equal(detail.replies[0].body, 'Existing candidate'); assert.equal(detail.replies[0].attemptId, null);
        assert.equal(detail.replies[0].attachments[0].name, 'existing.txt');
        assert.equal(migrated.reply(peer, 'legacy-task', 'legacy-reply').attachments[0].name, 'existing.txt');
        assert.equal(migrated.download(peer, 'legacy-file').data, Buffer.from('old').toString('base64'));
        assert.equal(detail.attempts.length, 0); assert.equal(detail.validations.length, 0); assert.equal(detail.decision, null);
        assert.equal(migrated.sync(peer, 0).events[0].subjectId, null);
        assert.equal(migrated.db.pragma('integrity_check', { simple: true }), 'ok');
        assert.deepEqual(migrated.db.pragma('foreign_key_check'), []);
      } finally { migrated.db.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
