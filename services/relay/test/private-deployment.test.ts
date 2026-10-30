import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PrivateStore } from '../src/private-store.js';
import { createPrivateRelay } from '../src/private-server.js';

test('standalone deployment: health, registration, same-account pairing and approval', async () => {
  const store = new PrivateStore(':memory:');
  const relay = createPrivateRelay(store, 'https://relay.example.test:8443');
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const origin = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
  const post = async (path: string, body: object, token?: string) => {
    const response = await fetch(origin + '/v1/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    assert.deepEqual(await (await fetch(origin + '/health')).json(), { protocol: 'dsh-desktop-remote-v1', ok: true, relayId: store.relayId });
    store.provision('deployment@example.test', 'local-test-password');
    const code = store.registration('deployment@example.test');
    const device = await post('register', { code, name: 'Test desktop' });
    assert.equal(device.status, 201);
    assert.equal((await post('register', { code, name: 'Duplicate' })).status, 403);
    const login = await post('login', { email: 'deployment@example.test', password: 'local-test-password' });
    assert.equal(login.status, 200);
    const invitation = await post('invite', { deviceId: device.body.deviceId }, device.body.deviceToken);
    const claim = await post('claim', { inviteId: invitation.body.inviteId, claimSecret: invitation.body.claimSecret, name: 'Test phone' }, login.body.accessToken);
    assert.equal(claim.status, 201);
    const credentials = { bindingId: claim.body.bindingId };
    assert.equal((await post('status', credentials, claim.body.bindingToken)).body.state, 'pending');
    assert.equal((await post('ticket', credentials, claim.body.bindingToken)).status, 403);
    assert.equal((await post('approve', { deviceId: device.body.deviceId, ...credentials, role: 'viewer' }, device.body.deviceToken)).status, 200);
    assert.equal((await post('status', credentials, claim.body.bindingToken)).body.role, 'viewer');
    assert.equal((await post('ticket', credentials, claim.body.bindingToken)).status, 503);
    assert.equal((await post('revoke', { deviceId: device.body.deviceId, ...credentials }, device.body.deviceToken)).status, 200);
    assert.equal((await post('status', credentials, claim.body.bindingToken)).status, 403);
    const qr = await post('invite', { deviceId: device.body.deviceId, qr: true }, device.body.deviceToken);
    const scanned = await post('claim-qr', { ...qr.body, name: 'QR phone' });
    assert.equal(scanned.status, 201);
    assert.equal((await post('claim-qr', { ...qr.body, name: 'Replay' })).status, 409);
    const phone = { bindingId: scanned.body.bindingId };
    assert.equal((await post('approve', { deviceId: device.body.deviceId, ...phone, role: 'control' }, device.body.deviceToken)).status, 200);
    assert.equal((await post('unbind', phone, scanned.body.bindingToken)).status, 200);
    assert.equal((await post('unbind', phone, scanned.body.bindingToken)).status, 200);
    const states = await post('bindings', { deviceId: device.body.deviceId }, device.body.deviceToken);
    assert.ok(states.body.bindings.some((b: any) => b.id === phone.bindingId && b.state === 'revoked'));
  } finally { await relay.close(); store.db.close(); }
});
