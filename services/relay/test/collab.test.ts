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
    assert.equal(detail.task.status, 'review'); assert.equal(detail.replies.length, 2);
    assert.equal(detail.replies[1].solution.report.usage.totals.outputTokens, null);
    const accept = { ...operation(), replyId: solved.body.id, revision: detail.task.revision };
    assert.equal((await f.call(b, `tasks/${task.id}/accept`, accept)).status, 403);
    assert.equal((await f.call(a, `tasks/${task.id}/accept`, accept)).body.status, 'resolved');
    assert.equal((await f.call(c, 'inbox')).body.items[0].kind, 'solution.accepted');
    assert.equal((await f.call(b, 'tasks?view=participating')).body.tasks.length, 1);
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
