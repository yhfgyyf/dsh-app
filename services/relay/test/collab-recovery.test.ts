import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrivateStore } from '../src/private-store.js';
import { createPrivateRelay } from '../src/private-server.js';
import { CollabStore } from '../src/collab-store.js';
import { createCollabServer, relayAuthorizer, type CollabAuthorizer } from '../src/collab-server.js';

const secret = 'collaboration-recovery-fixture-secret-32-bytes';
const recoverySecret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(options: { validationMode?: 'legacy' | 'wrong-receipt'; authorize?: (base: CollabAuthorizer) => CollabAuthorizer } = {}) {
  const relayStore = new PrivateStore(':memory:'), store = new CollabStore(':memory:');
  relayStore.provision('recovery@example.test', 'isolated-fixture-password');
  const register = () => relayStore.register(relayStore.registration('recovery@example.test'), 'same name')!;
  const oldDevice = register(), newDevice = register();
  const relay = createPrivateRelay(relayStore, 'http://127.0.0.1:8787', { collabSecret: secret });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const relayOrigin = `http://127.0.0.1:${(relay.server.address() as any).port}`;
  const privateCall = async (path: string, token: string, body: unknown) => {
    const res = await fetch(relayOrigin + '/v1/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  // A pre-recovery private relay validates grants but ignores the new request field.
  const legacy = options.validationMode ? createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the bounded test request */ }
    const upstream = await fetch(relayOrigin + '/v1/collab-validate', { method: 'POST', headers: { authorization: req.headers.authorization ?? '' }, body: '{}' });
    const value = await upstream.json();
    if (options.validationMode === 'wrong-receipt') value.unregisteredDeviceId = 'another-missing-device';
    res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  }) : undefined;
  if (legacy) { legacy.listen(0, '127.0.0.1'); await once(legacy, 'listening'); }
  const authOrigin = legacy ? `http://127.0.0.1:${(legacy.address() as any).port}` : relayOrigin;
  const base = relayAuthorizer(authOrigin, secret);
  const app = createCollabServer(store, options.authorize ? options.authorize(base) : base);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const grant = async (device: typeof oldDevice) => {
    const result = await privateCall('collab-token', device.deviceToken, { deviceId: device.deviceId });
    assert.equal(result.status, 200); return result.body.token as string;
  };
  const oldToken = await grant(oldDevice), newToken = await grant(newDevice);
  const call = async (token: string, path: string, body?: unknown) => {
    const res = await fetch(origin + '/collab/v1/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  const unregister = async () => assert.equal((await privateCall('unregister', oldDevice.deviceToken, { deviceId: oldDevice.deviceId })).status, 200);
  return { store, relayStore, register, oldDevice, newDevice, oldToken, newToken, grant, privateCall, call, unregister,
    close: async () => { await app.close(); if (legacy) await new Promise<void>(r => legacy.close(() => r())); await relay.close(); store.db.close(); relayStore.db.close(); } };
}

test('legacy joins keep working; a current owner enrolls a recovery hash without exposing or overwriting it', async () => {
  const f = await fixture();
  try {
    const body = { id: randomUUID(), nickname: 'Original' }, key = recoverySecret();
    const legacy = await f.call(f.oldToken, 'join', body);
    assert.equal(legacy.status, 200); assert.deepEqual(legacy.body.recovery, { supported: true, ready: false });
    const enrolled = await f.call(f.oldToken, 'join', { ...body, recoverySecret: key });
    assert.equal(enrolled.status, 200); assert.deepEqual(enrolled.body.recovery, { supported: true, ready: true });
    const stored = f.store.db.prepare('SELECT recoveryHash FROM collab_peers WHERE id = ?').get(body.id) as { recoveryHash: string };
    assert.equal(stored.recoveryHash, digest(key));
    for (const value of [undefined, recoverySecret()]) {
      const joined = await f.call(f.oldToken, 'join', { ...body, recoverySecret: value });
      assert.equal(joined.status, 200); assert.deepEqual(joined.body.recovery, { supported: true, ready: false });
      assert.deepEqual(f.store.db.prepare('SELECT recoveryHash FROM collab_peers WHERE id = ?').get(body.id), stored);
    }
    assert.equal((await f.call(f.oldToken, 'me')).status, 200);
    const publicData = JSON.stringify([enrolled.body, (await f.call(f.oldToken, 'me')).body]);
    assert.ok(!publicData.includes(key) && !publicData.includes(stored.recoveryHash));
  } finally { await f.close(); }
});

test('unregister and register recover the same peer and all authored data; a lost response is safe to retry', async () => {
  const f = await fixture();
  try {
    const body = { id: randomUUID(), nickname: 'Original', recoverySecret: recoverySecret() };
    assert.equal((await f.call(f.oldToken, 'join', body)).status, 200);
    const task = await f.call(f.oldToken, 'tasks', { operationId: randomUUID(), title: 'Preserve authorship', description: 'Existing work' });
    assert.equal(task.status, 200);
    const reply = await f.call(f.oldToken, `tasks/${task.body.id}/replies`, { operationId: randomUUID(), kind: 'message', actor: 'user', body: 'Existing discussion', baseRevision: 1 });
    assert.equal(reply.status, 200);
    const tables = (f.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'collab_%' AND name != 'collab_peers' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const contents = () => tables.map(name => [name, f.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
    const before = contents();
    const peerBefore = f.store.db.prepare('SELECT * FROM collab_peers WHERE id = ?').get(body.id) as Record<string, unknown>;
    await f.unregister();
    const migrated = await f.call(f.newToken, 'join', body);
    assert.equal(migrated.status, 200); assert.equal(migrated.body.id, body.id);
    assert.deepEqual(migrated.body.recovery, { supported: true, ready: true });
    assert.deepEqual(f.store.db.prepare('SELECT * FROM collab_peers WHERE id = ?').get(body.id), { ...peerBefore, device: f.newDevice.deviceId });
    assert.deepEqual(contents(), before);
    assert.deepEqual(await f.call(f.newToken, 'join', body), migrated);
    assert.equal((await f.call(f.newToken, 'me')).body.peer.id, body.id);
    assert.equal((await f.call(f.newToken, `tasks/${task.body.id}`)).body.task.authorId, body.id);
    assert.equal((await f.call(f.oldToken, 'me')).status, 403, 'cached old grants cannot read after unregister');
    assert.equal(f.store.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(f.store.db.pragma('foreign_key_check'), []);
  } finally { await f.close(); }
});

test('recovery rejects missing proof, a wrong proof, an active source, occupied target and banned peer', async t => {
  const cases = [
    { name: 'legacy identity has no proof', enroll: false, supplied: 'correct', active: false, error: 'identity_recovery_unavailable' },
    { name: 'missing secret', enroll: true, supplied: 'missing', active: false, error: 'identity_recovery_required' },
    { name: 'wrong secret', enroll: true, supplied: 'wrong', active: false, error: 'identity_recovery_invalid' },
    { name: 'old device remains registered', enroll: true, supplied: 'correct', active: true, error: 'identity_device_active' },
    { name: 'new device already has another peer', enroll: true, supplied: 'correct', active: false, occupied: true, error: 'identity_conflict' },
    { name: 'original peer is suspended', enroll: true, supplied: 'correct', active: false, banned: true, error: 'peer_suspended' },
  ];
  for (const check of cases) await t.test(check.name, async () => {
    const f = await fixture();
    try {
      const body = { id: randomUUID(), nickname: 'same name' }, key = recoverySecret();
      assert.equal((await f.call(f.oldToken, 'join', { ...body, ...(check.enroll ? { recoverySecret: key } : {}) })).status, 200);
      if (check.occupied) assert.equal((await f.call(f.newToken, 'join', { id: randomUUID(), nickname: 'same name' })).status, 200);
      if (check.banned) f.store.db.prepare('UPDATE collab_peers SET banned = 1 WHERE id = ?').run(body.id);
      if (!check.active) await f.unregister();
      const before = f.store.db.prepare('SELECT * FROM collab_peers ORDER BY id').all();
      const request = { ...body, ...(check.supplied === 'missing' ? {} : { recoverySecret: check.supplied === 'correct' ? key : recoverySecret() }) };
      const rejected = await f.call(f.newToken, 'join', request);
      assert.equal(rejected.status, check.banned ? 403 : 409); assert.equal(rejected.body.error, check.error);
      assert.deepEqual(f.store.db.prepare('SELECT * FROM collab_peers ORDER BY id').all(), before);
    } finally { await f.close(); }
  });
});

test('ordinary joins survive old validators, but recovery requires a matching explicit absence receipt', async t => {
  for (const validationMode of ['legacy', 'wrong-receipt'] as const) await t.test(validationMode, async () => {
    const f = await fixture({ validationMode });
    try {
      const body = { id: randomUUID(), nickname: 'Original', recoverySecret: recoverySecret() };
      const enrolled = await f.call(f.oldToken, 'join', body);
      assert.equal(enrolled.status, 200);
      assert.deepEqual(enrolled.body.recovery, { supported: true, ready: true }, 'ready confirms stored proof, not the private relay upgrade');
      await f.unregister();
      const recovered = await f.call(f.newToken, 'join', body);
      assert.equal(recovered.status, 503); assert.equal(recovered.body.error, 'identity_recovery_unsupported');
      assert.equal((f.store.db.prepare('SELECT device FROM collab_peers WHERE id = ?').get(body.id) as any).device, f.oldDevice.deviceId);
    } finally { await f.close(); }
  });
});

test('two concurrent devices cannot both consume the same orphan identity', async () => {
  let checks = 0, release!: () => void;
  const bothReady = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ authorize: base => async (token, oldDevice) => {
    const identity = await base(token, oldDevice);
    if (oldDevice) { if (++checks === 2) release(); await bothReady; }
    return identity;
  } });
  try {
    const body = { id: randomUUID(), nickname: 'Original', recoverySecret: recoverySecret() };
    assert.equal((await f.call(f.oldToken, 'join', body)).status, 200);
    const other = f.register(), otherToken = await f.grant(other);
    await f.unregister();
    const results = await Promise.all([f.call(f.newToken, 'join', body), f.call(otherToken, 'join', body)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.find(result => result.status === 409)?.body.error, 'identity_conflict');
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM collab_peers').get() as any).n, 1);
  } finally { release(); await f.close(); }
});

test('mobile grants cannot enroll a recovery proof or request an unregistered-device receipt', async () => {
  const f = await fixture();
  try {
    const body = { id: randomUUID(), nickname: 'Original' };
    assert.equal((await f.call(f.oldToken, 'join', body)).status, 200);
    const binding = f.relayStore.bind(f.oldDevice.deviceId, 'phone')!;
    const mobile = await f.privateCall('collab-token', binding.bindingToken, { bindingId: binding.bindingId });
    assert.equal(mobile.status, 200);
    assert.equal((await f.call(mobile.body.token, 'join', { ...body, recoverySecret: recoverySecret() })).status, 200);
    assert.equal((f.store.db.prepare('SELECT recoveryHash FROM collab_peers WHERE id = ?').get(body.id) as any).recoveryHash, null);
    const denied = await f.privateCall('collab-validate', mobile.body.token, { requireUnregisteredDeviceId: 'missing-device' });
    assert.equal(denied.status, 403); assert.equal(denied.body.error, 'desktop_write_required');
  } finally { await f.close(); }
});

test('malformed recovery material and unregistered destination grants leave the original peer unchanged', async () => {
  const f = await fixture();
  try {
    const body = { id: randomUUID(), nickname: 'Original', recoverySecret: recoverySecret() };
    assert.equal((await f.call(f.oldToken, 'join', body)).status, 200);
    for (const malformed of ['', 'short', 'a'.repeat(44), 42, null]) {
      const result = await f.call(f.oldToken, 'join', { ...body, recoverySecret: malformed });
      assert.equal(result.status, 400); assert.equal(result.body.error, 'invalid_recovery_secret');
    }
    await f.unregister();
    assert.equal((await f.privateCall('unregister', f.newDevice.deviceToken, { deviceId: f.newDevice.deviceId })).status, 200);
    assert.equal((await f.call(f.newToken, 'join', body)).status, 403);
    assert.equal((f.store.db.prepare('SELECT device FROM collab_peers WHERE id = ?').get(body.id) as any).device, f.oldDevice.deviceId);
  } finally { await f.close(); }
});
