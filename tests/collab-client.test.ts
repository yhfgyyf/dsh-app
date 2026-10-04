import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollabClient } from '../src/runtime/collab-client.ts';
import { CollabHost, PLUGIN_VERSION } from '../src/runtime/collab-host.ts';
import { randomUUID } from 'node:crypto';
import { collabSettings, type CollabLocalAttempt } from '../src/shared/collab.ts';

test('registration state follows native credentials without probing or losing the local identity and drafts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-registration-'));
  let registered = false;
  const client = new CollabClient(home, { isRegistered: () => registered, grant: async () => { throw new Error('No network expected'); } });
  try {
    await client.restore(); const peer = client.state().peer;
    client.data.drafts.task = { body: 'Keep this draft' }; await client.save();
    assert.equal(client.state().registered, false);
    registered = true; assert.equal(client.state().registered, true);
    registered = false; assert.equal(client.state().registered, false);
    assert.deepEqual(client.state().peer, peer);
    assert.deepEqual(client.data.drafts.task, { body: 'Keep this draft' });
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

for (const scenario of ['matched', 'mismatch', 'peer_not_joined', 'identity_conflict', 'unknown_error']) {
  test(`identity RPC diagnoses ${scenario} without joining or changing local records`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-collab-identity-'));
    const requests: string[] = [];
    let peer: { id: string; nickname: string; createdAt: number } = { id: randomUUID(), nickname: 'Server nickname', createdAt: 1 };
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.method !== 'GET' || req.url !== '/collab/v1/me') { res.writeHead(409); res.end('{"error":"unexpected_write"}'); return; }
      if (scenario === 'matched' || scenario === 'mismatch') {
        res.end(JSON.stringify({ peer: { ...peer, token: 'server-private-token', device: 'server-private-device' }, unread: 9, protocol: 1 }));
      } else {
        res.writeHead(scenario === 'unknown_error' ? 500 : 409);
        res.end(JSON.stringify({ error: scenario === 'unknown_error' ? 'fixture-token fixture-ca' : scenario }));
      }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const client = new CollabClient(home, { isRegistered: () => true, grant: async () => ({ origin, token: 'fixture-token', ca: 'fixture-ca', expiresAt: Date.now() + 300000 }) });
    try {
      await client.restore(); client.start();
      if (scenario === 'matched') peer = { ...peer, id: client.data.peerId };
      if (scenario !== 'peer_not_joined') client.data.origin = origin;
      client.data.drafts.task = { body: 'Keep this private draft' }; client.data.cursor = 42; await client.save();
      const before = structuredClone(client.data), stateBefore = client.state(), file = join(home, 'collaboration/profile.json');
      const bytesBefore = await readFile(file);
      const host = new CollabHost(client, {} as any, () => undefined, { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' });
      const diagnostic = scenario === 'matched' || scenario === 'mismatch' ? { serverPeer: peer } : { remoteError: { code: scenario === 'unknown_error' ? 'identity_lookup_failed' : scenario, status: scenario === 'unknown_error' ? 500 : 409 } };
      assert.deepEqual(await host.handle('identity', { args: {} }, new AbortController().signal), { ok: true, value: {
        localPeerId: before.peerId, localNickname: before.nickname, origin, ...diagnostic, pluginVersion: PLUGIN_VERSION,
      } });
      assert.deepEqual(requests, ['GET /collab/v1/me'], 'Identity diagnosis must not join, sync, rename or publish');
      assert.deepEqual(client.data, before);
      assert.deepEqual(client.state(), stateBefore);
      assert.deepEqual(await readFile(file), bytesBefore);
    } finally { await client.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
  });
}

test('identity diagnosis retains the relay-origin guard and respects cancellation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-identity-guard-'));
  let grants = 0;
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { grants++; return { origin: 'https://new-relay.invalid', token: 'fixture-token', expiresAt: Date.now() + 300000 }; } });
  try {
    await client.restore(); client.start(); client.data.origin = 'https://old-relay.invalid'; await client.save();
    const before = structuredClone(client.data), file = join(home, 'collaboration/profile.json'), bytesBefore = await readFile(file);
    await assert.rejects(client.identity(), /已切换中继/);
    const aborted = AbortSignal.abort(); await assert.rejects(client.identity(aborted), { name: 'AbortError' });
    assert.equal(grants, 1, 'An already cancelled diagnosis must not request a grant');
    assert.deepEqual(client.data, before); assert.deepEqual(await readFile(file), bytesBefore);
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

test('identity diagnosis hides credential-grant errors without changing local records', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-identity-grant-'));
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('private-token private-ca'); } });
  try {
    await client.restore(); client.start();
    const before = structuredClone(client.data), file = join(home, 'collaboration/profile.json'), bytesBefore = await readFile(file);
    assert.deepEqual(await client.identity(), { localPeerId: before.peerId, localNickname: before.nickname, origin: undefined, remoteError: { code: 'identity_grant_failed' } });
    assert.deepEqual(client.data, before); assert.deepEqual(await readFile(file), bytesBefore);
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

test('semantic updates persist per attempt without unpausing it or marking them reviewed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-events-'));
  const broker = { isRegistered: () => true, grant: async () => { throw new Error('No network expected'); } };
  const client = new CollabClient(home, broker);
  try {
    await client.restore(); client.start();
    const id = randomUUID(), taskId = randomUUID(), other = randomUUID();
    const attempt: CollabLocalAttempt = { id, taskId, title: 'Task', direction: 'Reproduce the evidence', baseRevision: 1, currentTaskRevision: 1,
      status: 'paused', desiredState: 'paused', executionMode: 'continuous', publishMode: 'review', limits: collabSettings(1000, 10),
      startedAt: 1, updatedAt: 1, runIds: [], nextStep: '', waitReason: '用户暂停', wakeOn: ['reply.created'], usedTokens: 0, usedMillis: 0,
      receivedCursor: 0, reviewedCursor: 0, pendingEvents: [], decisions: [] };
    client.data.attempts[id] = attempt;
    const event = (id: number, kind: string, actorId: string = other, relatedTaskId: string = taskId) => ({ id, taskId: relatedTaskId, actorId, kind, at: id, subjectId: null });
    const events = [event(1, 'reply.created'), { ...event(2, 'reply.created', client.data.peerId), sourceAttemptId: id }, event(3, 'participation.updated'), event(4, 'reply.created', other, randomUUID()), event(5, 'solution.submitted'), event(6, 'task.updated', client.data.peerId), event(7, 'reply.created', client.data.peerId), { ...event(8, 'solution.submitted', client.data.peerId), sourceAttemptId: randomUUID() }];
    client.api = async () => ({ cursor: 8, unread: 3, hasMore: false, events });
    await client.sync(); await client.sync();
    assert.deepEqual(attempt.pendingEvents.map(event => event.id), [1, 5, 6, 7, 8]);
    assert.equal(attempt.receivedCursor, 8); assert.equal(attempt.reviewedCursor, 0);
    assert.equal(attempt.status, 'paused'); assert.equal(attempt.desiredState, 'paused');
    // A UI caller cannot mutate the stored participation state through its snapshot.
    client.state().attempts[0].pendingEvents.length = 0;
    assert.equal(attempt.pendingEvents.length, 5);
    const restored = new CollabClient(home, broker); await restored.restore();
    assert.deepEqual(restored.data.attempts[id].pendingEvents.map(event => event.id), [1, 5, 6, 7, 8]);
    assert.equal(restored.data.attempts[id].desiredState, 'paused'); assert.equal(restored.data.attempts[id].reviewedCursor, 0);
    await restored.stop();
    attempt.desiredState = 'active'; attempt.status = 'waiting'; attempt.reviewedCursor = 100;
    client.api = async () => ({ cursor: 0, unread: 0, hasMore: false, reset: true, events: [] });
    await client.sync();
    assert.equal(attempt.desiredState, 'paused'); assert.match(attempt.waitReason, /历史已重置/);
    assert.equal(attempt.eventArchive?.[0].pendingEvents.length, 5, 'Journal reset must archive unreviewed local evidence');
    assert.equal(attempt.reviewedCursor, 0); assert.equal(attempt.pendingEvents.length, 0);
    assert.equal(attempt.eventEpoch, 1, 'An in-flight stage must not consume events from the replacement journal');
    client.api = async () => ({ cursor: 1, unread: 1, hasMore: false, events: [event(1, 'reply.created')] });
    await client.sync();
    assert.deepEqual(attempt.pendingEvents.map(event => event.id), [1], 'Reused event IDs belong to the new journal and must still arrive');
    assert.equal(attempt.desiredState, 'paused', 'New-journal updates still cannot undo the manual pause');
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

test('legacy local profiles keep runs and drafts and gain manual participation defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-profile-'));
  const broker = { isRegistered: () => false, grant: async () => { throw new Error('No network expected'); } };
  const client = new CollabClient(home, broker);
  try {
    await client.restore();
    const path = join(home, 'collaboration/profile.json'), old = JSON.parse(await readFile(path, 'utf8'));
    delete old.attempts; delete old.settings.executionMode;
    old.drafts.task = { body: 'Keep my unpublished work' };
    await writeFile(path, JSON.stringify(old));
    const restored = new CollabClient(home, broker); await restored.restore();
    assert.deepEqual(restored.data.attempts, {}); assert.equal(restored.data.settings.executionMode, 'manual');
    assert.equal(restored.data.drafts.task && (restored.data.drafts.task as any).body, 'Keep my unpublished work');
    assert.equal(restored.data.peerId, client.data.peerId);
    await restored.stop();
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

test('legacy public retry metadata never promotes a task title or private direction into a public direction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-public-direction-'));
  const broker = { isRegistered: () => true, grant: async () => { throw new Error('Fixture only'); } };
  const client = new CollabClient(home, broker); await client.restore();
  try {
    const id = randomUUID(), operationId = randomUUID();
    client.data.attempts[id] = { id, taskId: randomUUID(), title: 'Public task title', direction: 'Private local instructions',
      baseRevision: 1, currentTaskRevision: 1, status: 'waiting', desiredState: 'active', executionMode: 'continuous', publishMode: 'review', limits: collabSettings(1000, 10),
      startedAt: 1, updatedAt: 1, runIds: [], nextStep: 'Check new data', waitReason: 'Waiting for data', wakeOn: ['reply.created'], usedTokens: 0, usedMillis: 0,
      receivedCursor: 0, reviewedCursor: 0, pendingEvents: [], decisions: [],
      publicUpdate: { operationId, payload: { operationId, id, status: 'waiting', direction: 'Public task title' } } };
    await client.save();
    const restored = new CollabClient(home, broker); await restored.restore();
    const attempt = restored.data.attempts[id];
    assert.equal(attempt.publicDirection, undefined); assert.equal(attempt.direction, 'Private local instructions');
    assert.equal(attempt.publicUpdate!.payload.direction, '');
    assert.notEqual(attempt.publicUpdate!.operationId, operationId);
    assert.equal(attempt.publicUpdate!.payload.operationId, attempt.publicUpdate!.operationId);
    await restored.stop();
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

test('continuous participation requires a finite cumulative budget', () => {
  assert.throws(() => collabSettings(0, 0, 'review', 'continuous'), /有限/);
  assert.equal(collabSettings(0, 30, 'manual', 'continuous').executionMode, 'continuous');
  assert.equal(collabSettings(0, 0, 'review', 'manual').executionMode, 'manual');
  assert.throws(() => collabSettings(1000, 10, 'review', 'automatic'), /手动推进/);
});

test('collaboration reads and writes on demand over HTTP with WebSocket unavailable, then recovers on the next request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-http-'));
  let joins = 0, upgrades = 0, grants = 0, failRead = false, writes = 0;
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!); let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/collab/v1/join') { joins++; res.end(JSON.stringify({ id: body.id, nickname: body.nickname, createdAt: 1 })); return; }
    if (!joins) { res.writeHead(403); res.end('{"error":"peer_not_joined"}'); return; }
    if (req.url!.startsWith('/collab/v1/sync?')) { res.end(JSON.stringify({ cursor: 2, unread: 1, hasMore: false })); return; }
    if (req.url === '/collab/v1/tasks' && req.method === 'POST') { writes++; res.end('{"id":"fixture-task"}'); return; }
    if (failRead) { failRead = false; res.writeHead(503); res.end('{"error":"temporary_failure"}'); return; }
    res.end('{"tasks":[]}');
  });
  server.on('upgrade', (_req, socket) => { upgrades++; socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { grants++; return { origin, token: 'fixture-token', expiresAt: Date.now() + 300000 }; } });
  await client.restore();
  try {
    client.start(); assert.equal(grants, 0, 'Starting the plugin must not start presence or connection probes');
    await Promise.all([client.api('tasks'), client.api('tasks')]);
    assert.equal(joins, 1, 'Concurrent first reads must join only once');
    assert.equal(client.state().unread, 0);
    await client.sync(); assert.equal(client.state().unread, 1); assert.equal(client.state().cursor, 2);
    assert.ok(client.state().lastSyncAt);
    failRead = true; await assert.rejects(client.api('tasks'), /temporary_failure/);
    assert.deepEqual(await client.api('tasks'), { tasks: [] });
    assert.equal((await client.api('tasks', { title: 'Explicit user post' })).id, 'fixture-task');
    await client.sync(); assert.equal(writes, 1); assert.equal(joins, 1); assert.equal(upgrades, 0);
    assert.ok(paths.every(path => !path.includes('/events')));
  } finally { await client.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
