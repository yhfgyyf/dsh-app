import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { PrivateStore } from '../src/private-store.js';
import { createPrivateRelay } from '../src/private-server.js';
import { RemoteBridge } from '../../../src/runtime/remote/bridge.ts';
import { RemoteTestClient, relayPost } from '../../../tests/remote-client.ts';

test('private account, one-use registration, same-account claim, expiry and revocation', () => {
  const store = new PrivateStore(':memory:');
  try {
    store.provision('test@example.test', 'test-password-long');
    assert.equal(store.login('test@example.test', 'wrong'), false);
    assert.equal(store.login('test@example.test', 'test-password-long'), true);
    const code = store.registration('test@example.test');
    const d = store.register(code, 'desktop')!; assert.ok(d);
    assert.equal(store.register(code, 'duplicate'), undefined);
    const invite = store.invite(d.deviceId);
    assert.equal(store.claim('other@example.test', invite.inviteId, invite.claimSecret, 'phone'), undefined);
    const b = store.claim('test@example.test', invite.inviteId, invite.claimSecret, 'phone')!;
    assert.equal(store.claim('test@example.test', invite.inviteId, invite.claimSecret, 'duplicate'), undefined);
    assert.equal(store.binding(b.bindingId, b.bindingToken)?.state, 'pending');
    assert.equal(store.approve(d.deviceId, b.bindingId, 'viewer'), true);
    assert.equal(store.approve(d.deviceId, b.bindingId, 'control'), false);
    store.revoke(d.deviceId, b.bindingId);
    assert.equal(store.binding(b.bindingId, b.bindingToken), undefined);
    const expired = store.invite(d.deviceId); store.db.prepare('UPDATE remote_invites SET expires = 0').run();
    assert.equal(store.claim('test@example.test', expired.inviteId, expired.claimSecret, 'phone'), undefined);
  } finally { store.db.close(); }
});

test('real relay + desktop bridge: authenticated encrypted transfer, chunked files, denied viewer mutation, live revoke', async () => {
  const store = new PrivateStore(':memory:');
  const relay = createPrivateRelay(store, 'http://127.0.0.1:8787');
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const origin = `http://127.0.0.1:${(relay.server.address() as any).port}`;
  const received: string[] = [];
  const host = createServer(async (req, res) => {
    if (req.url?.startsWith('/?token=')) { res.setHeader('set-cookie', 'local_secret=host_only; HttpOnly'); res.end(); return; }
    assert.equal(req.headers.cookie, 'local_secret=host_only');
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    received.push(req.url!); res.setHeader('content-type', 'application/json'); res.end(Buffer.concat(chunks));
  });
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  const endpoint = `http://127.0.0.1:${(host.address() as any).port}`;
  let online!: () => void; const ready = new Promise<void>(r => { online = r; });
  let disconnected!: () => void; const absent = new Promise<void>(r => { disconnected = r; });
  let connections: string[] = [];
  const bridge = new RemoteBridge(WebSocket, endpoint, endpoint + '/?token=fixture', s => {
    if (s.status === 'online') {
      if (connections.length && !s.connections?.length) disconnected();
      connections = s.connections ?? []; online();
    }
  });
  const client = new RemoteTestClient(), viewer = new RemoteTestClient();
  try {
    store.provision('test@example.test', 'test-password-long');
    const d = store.register(store.registration('test@example.test'), 'desktop')!;
    const invite = store.invite(d.deviceId);
    const login = await relayPost(origin, 'login', { email: 'test@example.test', password: 'test-password-long' });
    const b = (await relayPost(origin, 'claim', { inviteId: invite.inviteId, claimSecret: invite.claimSecret, name: 'phone' }, login.body.accessToken)).body;
    assert.equal((await relayPost(origin, 'ticket', { bindingId: b.bindingId }, b.bindingToken)).status, 403);
    store.approve(d.deviceId, b.bindingId, 'control');
    const key = Buffer.alloc(32, 5).toString('base64url');
    const credentials = { relay: origin, ...d, bindings: [{ id: b.bindingId, name: 'phone', account: 'test@example.test', role: 'control' as const, key, revoked: false }] };
    await bridge.configure({ enabled: true, credentials }); await ready;
    await client.connect(origin, b.bindingId, b.bindingToken, key);
    assert.deepEqual(connections, [b.bindingId]);
    const contents = Buffer.alloc(1024 * 1024 + 21, 'a');
    const result = await client.http('/api/session/uploadFileBinary', contents);
    assert.equal(result.status, 200); assert.deepEqual(result.body, contents);
    // The bridge's binding, not the phone or relay's claim of its role, controls authorization.
    credentials.bindings[0].role = 'viewer' as any;
    await viewer.connect(origin, b.bindingId, b.bindingToken, key);
    await assert.rejects(() => viewer.http('/api/session/prompt'));
    assert.equal(received.includes('/api/session/prompt'), false);
    const revoked = await relayPost(origin, 'revoke', { deviceId: d.deviceId, bindingId: b.bindingId }, d.deviceToken);
    assert.equal(revoked.status, 200);
    assert.equal((await relayPost(origin, 'ticket', { bindingId: b.bindingId }, b.bindingToken)).status, 403);
    await assert.rejects(() => client.next());
    await absent;
    assert.deepEqual(connections, []);
  } finally { client.close(); viewer.close(); bridge.stop(); await relay.close(); await new Promise<void>(r => host.close(() => r())); store.db.close(); }
});
