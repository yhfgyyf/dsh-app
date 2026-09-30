import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { LanRemoteAccess, privateIPv4, sameNetwork } from '../src/runtime/remote/lan.ts';
import type { RemoteRuntimeConfig } from '../src/shared/remote-access.ts';
import { RemoteTestClient } from './remote-client.ts';
const WebSocket = createRequire(new URL('../.runtime/package.json', import.meta.url))('ws');

test('LAN uses private addresses and actual interface netmasks', () => {
  for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.2.113']) assert.equal(privateIPv4(ip), true);
  for (const ip of ['127.0.0.1', '172.15.0.1', '172.32.0.1', '8.8.8.8', '192.168.999.1']) assert.equal(privateIPv4(ip), false);
  assert.equal(sameNetwork('::ffff:192.168.3.2', [{ address: '192.168.2.113', netmask: '255.255.254.0' }]), true);
  assert.equal(sameNetwork('192.168.4.2', [{ address: '192.168.2.113', netmask: '255.255.254.0' }]), false);
});

test('LAN pairs once, authenticates and forwards without exposing Host auth; both ends revoke', async () => {
  const host = createServer(async (req, res) => {
    if (req.url === '/?token=fixture') { res.setHeader('set-cookie', 'host_secret=loopback_only; HttpOnly'); res.end(); return; }
    assert.equal(req.headers.cookie, 'host_secret=loopback_only');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json'); res.end(Buffer.concat(chunks));
  });
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  const endpoint = `http://127.0.0.1:${(host.address() as any).port}`;
  const key = randomBytes(32).toString('base64url');
  const config: RemoteRuntimeConfig = { enabled: true, local: { deviceId: 'test_computer', bindings: [] }, invitation: { id: 'test_invitation', key, expiresAt: Date.now() + 120000 } };
  let origin = '', pairCount = 0, connected: string[] = [];
  const lan = new LanRemoteAccess(WebSocket, endpoint, endpoint + '/?token=fixture', state => { origin = state.origins[0] ?? ''; connected = state.connections; }, async action => {
    if (action.type === 'unbind') {
      config.local!.bindings.find(b => b.id === action.bindingId)!.revoked = true;
      await lan.configure(config); return { ok: true };
    }
    pairCount++;
    config.local!.bindings.push({ id: 'test_binding', name: action.name, account: 'local', role: 'control', key, revoked: false });
    config.invitation = undefined; await lan.configure(config);
    return { bindingId: 'test_binding', bindingToken: '', key, computerId: 'test_computer', lanOrigins: [origin] };
  }, () => [{ address: '127.0.0.1', netmask: '255.0.0.0' }]);
  const clients: RemoteTestClient[] = [];
  const client = () => { const c = new RemoteTestClient(); clients.push(c); return c; };
  try {
    await lan.configure(config);
    assert.equal((await fetch(origin + '/api/session/list')).status, 404);
    await assert.rejects(() => client().connectLan(origin, 'test_computer', key, { bindingId: 'unknown_phone' }));
    await assert.rejects(() => client().connectLan(origin, 'test_computer', randomBytes(32).toString('base64url'), { inviteId: 'test_invitation' }));
    const pairing = client(); await pairing.connectLan(origin, 'test_computer', key, { inviteId: 'test_invitation' });
    pairing.send({ type: 'pair', name: 'Test Android' }); const receipt = await pairing.next();
    assert.equal(receipt.type, 'paired'); assert.equal(receipt.credential.bindingId, 'test_binding');
    assert.equal(JSON.stringify(receipt).includes('host_secret'), false); assert.equal(pairCount, 1);
    await assert.rejects(() => client().connectLan(origin, 'test_computer', key, { inviteId: 'test_invitation' }));
    const phone = client(); await phone.connectLan(origin, 'test_computer', key, { bindingId: 'test_binding' });
    assert.deepEqual(connected, ['test_binding']);
    const payload = Buffer.alloc(256 * 1024 + 13, 'x');
    assert.deepEqual((await phone.http('/api/session/list', payload)).body, payload);
    phone.send({ type: 'binding_unbind' }); assert.equal((await phone.next()).type, 'binding_unbound');
    assert.equal(config.local!.bindings[0].revoked, true);
    await assert.rejects(() => client().connectLan(origin, 'test_computer', key, { bindingId: 'test_binding' }));
    config.local!.bindings[0].revoked = false; await lan.configure(config);
    const second = client(); await second.connectLan(origin, 'test_computer', key, { bindingId: 'test_binding' });
    config.local!.bindings[0].revoked = true; await lan.configure(config);
    assert.equal((await second.next()).type, 'device_close');
    config.invitation = { id: 'expired_invite', key, expiresAt: Date.now() - 1 }; await lan.configure(config);
    await assert.rejects(() => client().connectLan(origin, 'test_computer', key, { inviteId: 'expired_invite' }));
    const denied = new WebSocket(origin.replace(/^http/, 'ws') + '/v1/lan', { origin: 'https://untrusted.example' });
    await once(denied, 'error'); denied.terminate();
  } finally { for (const c of clients) c.close(); await lan.stop(); await new Promise<void>(r => host.close(() => r())); }
});
