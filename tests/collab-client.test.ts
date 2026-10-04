import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, writeFile, rename, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollabClient } from '../src/runtime/collab-client.ts';
import { CollabHost, PLUGIN_VERSION } from '../src/runtime/collab-host.ts';
import { randomUUID } from 'node:crypto';
import { collabSettings, type CollabLocalAttempt } from '../src/shared/collab.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

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
        localPeerId: before.peerId, localNickname: before.nickname, origin, recovery: { supported: null, ready: false }, ...diagnostic, pluginVersion: PLUGIN_VERSION,
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
    assert.deepEqual(await client.identity(), { localPeerId: before.peerId, localNickname: before.nickname, origin: undefined, recovery: { supported: null, ready: false }, remoteError: { code: 'identity_grant_failed' } });
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

async function identityFixture(onJoin: (body: any, token: string, response: import('node:http').ServerResponse) => void | Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-recovery-'));
  const joined = new Set<string>(), requests: { path: string; token: string }[] = [];
  const tokenDevices = new Map([['grant-one', 'device-one']]);
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    requests.push({ path: request.url!, token }); response.setHeader('content-type', 'application/json');
    if (request.url === '/collab/v1/join') { joined.add(tokenDevices.get(token)!); await onJoin(JSON.parse(raw), token, response); return; }
    if (!joined.has(tokenDevices.get(token)!)) { response.writeHead(403); response.end('{"error":"peer_not_joined"}'); return; }
    response.end('{"tasks":[]}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  let deviceId = 'device-one', token = 'grant-one';
  const broker = { isRegistered: () => true, grant: async () => ({ origin, deviceId, token, expiresAt: Date.now() + 300000 }) };
  const client = new CollabClient(home, broker); await client.restore(); client.start();
  return { home, origin, broker, client, requests, registration: (device: string, grant: string) => { deviceId = device; token = grant; tokenDevices.set(grant, device); },
    close: async () => { await client.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); } };
}
const joinedPeer = (body: any, recovery: unknown = { supported: true, ready: true }) => ({ id: body.id, nickname: body.nickname, createdAt: 1, ...(recovery === undefined ? {} : { recovery }) });

test('a new registration on the same relay must join with its own device instead of reusing the old origin cache', async () => {
  const joins: string[] = [];
  const f = await identityFixture((body, token, response) => { joins.push(token); response.end(JSON.stringify(joinedPeer(body))); });
  try {
    await f.client.api('tasks'); f.registration('device-two', 'grant-two');
    assert.deepEqual(await f.client.api('tasks'), { tasks: [] });
    assert.deepEqual(joins, ['grant-one', 'grant-two']);
  } finally { await f.close(); }
});

test('recovery keys are persisted with private permissions before joining, survive restart and never enter public state or profile data', async () => {
  const keys: string[] = [], persisted: Promise<void>[] = [];
  let home = '';
  const f = await identityFixture((body, _token, response) => {
    keys.push(body.recoverySecret);
    const check = (async () => {
      const file = join(home, 'collaboration/recovery.json'), stored = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(stored.peerId, body.id); assert.equal(stored.recoverySecret, body.recoverySecret);
      assert.equal(Buffer.from(body.recoverySecret, 'base64url').length, 32);
      assert.equal(Buffer.from(body.recoverySecret, 'base64url').toString('base64url'), body.recoverySecret);
      if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    })();
    void check.catch(() => {}); persisted.push(check);
    response.end(JSON.stringify(joinedPeer(body)));
  });
  home = f.home;
  try {
    await f.client.api('tasks'); await Promise.all(persisted);
    assert.deepEqual(f.client.state().recovery, { supported: true, ready: true });
    assert.equal(JSON.stringify(f.client.state()).includes(keys[0]), false);
    assert.equal(JSON.stringify(f.client.data).includes(keys[0]), false);
    assert.equal((await readFile(join(home, 'collaboration/profile.json'), 'utf8')).includes(keys[0]), false);
    await f.client.stop(); const restored = new CollabClient(home, f.broker); await restored.restore(); restored.start();
    try { await restored.api('tasks'); await Promise.all(persisted); assert.equal(keys.length, 2); assert.equal(keys[1], keys[0]); }
    finally { await restored.stop(); }
  } finally { await f.close(); }
});

test('an old relay is explicitly unsupported and a refreshed grant retries recovery enrollment after a server upgrade', async () => {
  let upgraded = false, joins = 0; const keys: string[] = [];
  const f = await identityFixture((body, _token, response) => {
    joins++; keys.push(body.recoverySecret);
    response.end(JSON.stringify(upgraded ? joinedPeer(body) : { id: body.id, nickname: body.nickname, createdAt: 1 }));
  });
  try {
    await f.client.api('tasks'); await f.client.api('tasks');
    assert.equal(joins, 1); assert.deepEqual(f.client.state().recovery, { supported: false, ready: false });
    upgraded = true; f.registration('device-one', 'renewed-grant'); await f.client.api('tasks');
    assert.equal(joins, 2); assert.equal(keys[0], keys[1]); assert.deepEqual(f.client.state().recovery, { supported: true, ready: true });
    f.registration('device-one', 'another-grant'); await f.client.api('tasks'); assert.equal(joins, 2, 'A confirmed key needs no enrollment on every token refresh');
  } finally { await f.close(); }
});

for (const firstFails of [false, true]) test(`a concurrent replacement registration waits for the old join but does not inherit its ${firstFails ? 'failure' : 'success'}`, async () => {
  const entered = deferred(), release = deferred(), keys: string[] = [];
  const f = await identityFixture(async (body, token, response) => {
    keys.push(body.recoverySecret);
    if (token === 'grant-one') {
      entered.resolve(); await release.promise;
      if (firstFails) { response.writeHead(409); response.end('{"error":"identity_conflict"}'); return; }
    }
    response.end(JSON.stringify(joinedPeer(body)));
  });
  try {
    const first = f.client.api('tasks').then(value => ({ value }), error => ({ error })); await entered.promise;
    f.registration('device-two', 'grant-two'); const second = f.client.api('tasks');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.requests.filter(request => request.path.endsWith('/join')).length, 1);
    release.resolve(); const old = await first;
    assert.equal('error' in old, firstFails); assert.deepEqual(await second, { tasks: [] });
    assert.deepEqual(f.requests.filter(request => request.path.endsWith('/join')).map(request => request.token), ['grant-one', 'grant-two']);
    assert.equal(keys[0], keys[1]);
  } finally { release.resolve(); await f.close(); }
});

test('a cancelled replacement registration does not start its queued join', async () => {
  const entered = deferred(), release = deferred();
  const f = await identityFixture(async (body, _token, response) => { entered.resolve(); await release.promise; response.end(JSON.stringify(joinedPeer(body))); });
  try {
    const first = f.client.api('tasks'); await entered.promise;
    f.registration('device-two', 'grant-two'); const abort = new AbortController();
    const second = assert.rejects(f.client.api('tasks', undefined, abort.signal), { name: 'AbortError' });
    abort.abort(); release.resolve(); await first; await second;
    assert.equal(f.requests.filter(request => request.path.endsWith('/join')).length, 1);
  } finally { release.resolve(); await f.close(); }
});

test('a failed recovery-key write sends no join and a later retry must persist its key first', async () => {
  const f = await identityFixture((body, _token, response) => { response.end(JSON.stringify(joinedPeer(body))); });
  const folder = join(f.home, 'collaboration'), moved = join(f.home, 'temporarily-unavailable');
  try {
    await rename(folder, moved);
    await assert.rejects(f.client.api('tasks'), { code: 'ENOENT' }); assert.equal(f.requests.length, 0);
    await rename(moved, folder); await f.client.api('tasks');
    const stored = JSON.parse(await readFile(join(folder, 'recovery.json'), 'utf8'));
    assert.equal(stored.peerId, f.client.data.peerId); assert.equal(stored.recoverySecret.length, 43);
    assert.equal(f.requests.filter(request => request.path.endsWith('/join')).length, 1);
  } finally { await f.close(); }
});

test('a malformed existing recovery file is preserved and never replaced by a new key', async () => {
  const f = await identityFixture((body, _token, response) => { response.end(JSON.stringify(joinedPeer(body))); });
  try {
    const file = join(f.home, 'collaboration/recovery.json'), damaged = '{"version":1,"recoverySecret":"damaged"}';
    await writeFile(file, damaged, { mode: 0o600 });
    await assert.rejects(f.client.api('tasks'), /恢复凭据无效/); await assert.rejects(f.client.api('tasks'), /恢复凭据无效/);
    assert.equal(f.requests.length, 0); assert.equal(await readFile(file, 'utf8'), damaged);
  } finally { await f.close(); }
});

test('an existing recovery file regains private POSIX permissions before a join', { skip: process.platform === 'win32' }, async () => {
  const f = await identityFixture((body, _token, response) => { response.end(JSON.stringify(joinedPeer(body))); });
  try {
    await f.client.api('tasks'); await f.client.stop();
    const file = join(f.home, 'collaboration/recovery.json'), before = await readFile(file);
    await chmod(file, 0o644);
    const second = new CollabClient(f.home, f.broker); await second.restore(); second.start();
    try { await second.api('tasks'); assert.equal((await stat(file)).mode & 0o777, 0o600); assert.deepEqual(await readFile(file), before); }
    finally { await second.stop(); }
  } finally { await f.close(); }
});

test('a recovery-file symlink cannot redirect recovery enrollment', { skip: process.platform === 'win32' }, async () => {
  const f = await identityFixture((body, _token, response) => { response.end(JSON.stringify(joinedPeer(body))); });
  try {
    const target = join(f.home, 'outside.json'); await writeFile(target, '{}');
    await symlink(target, join(f.home, 'collaboration/recovery.json'));
    await assert.rejects(f.client.api('tasks'), /恢复凭据无效/);
    assert.equal(f.requests.length, 0); assert.equal(await readFile(target, 'utf8'), '{}');
  } finally { await f.close(); }
});

test('concurrent clients for one profile publish and use one recovery key', async () => {
  const keys: string[] = [];
  const f = await identityFixture((body, _token, response) => { keys.push(body.recoverySecret); response.end(JSON.stringify(joinedPeer(body))); });
  const second = new CollabClient(f.home, f.broker); await second.restore(); second.start();
  try {
    await Promise.all([f.client.api('tasks'), second.api('tasks')]);
    assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
    const stored = JSON.parse(await readFile(join(f.home, 'collaboration/recovery.json'), 'utf8'));
    assert.equal(stored.recoverySecret, keys[0]);
  } finally { await second.stop(); await f.close(); }
});

test('a lost join response and process restart reuse the persisted key and preserve local history', async () => {
  const keys: string[] = [];
  const f = await identityFixture((body, _token, response) => {
    keys.push(body.recoverySecret); if (keys.length === 1) response.destroy(); else response.end(JSON.stringify(joinedPeer(body)));
  });
  try {
    f.client.data.drafts.task = { body: 'Private work' }; f.client.data.cursor = 87; await f.client.save();
    const before = structuredClone(f.client.data);
    await assert.rejects(f.client.api('tasks')); await f.client.stop();
    const second = new CollabClient(f.home, f.broker); await second.restore(); second.start();
    try {
      await second.api('tasks'); assert.deepEqual(keys, [keys[0], keys[0]]);
      assert.deepEqual(second.data.drafts, before.drafts); assert.equal(second.data.peerId, before.peerId); assert.equal(second.data.cursor, before.cursor);
    } finally { await second.stop(); }
  } finally { await f.close(); }
});

test('a server that accepts normal join without matching recovery proof stays not ready', async () => {
  const f = await identityFixture((body, _token, response) => { response.end(JSON.stringify(joinedPeer(body, { supported: true, ready: false }))); });
  try {
    await f.client.api('tasks'); assert.deepEqual(f.client.state().recovery, { supported: true, ready: false });
    const diagnostic = await f.client.identity(); assert.deepEqual(diagnostic.recovery, { supported: true, ready: false });
    const secret = JSON.parse(await readFile(join(f.home, 'collaboration/recovery.json'), 'utf8')).recoverySecret;
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  } finally { await f.close(); }
});
