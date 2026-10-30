import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import QRCode from 'qrcode/lib/server.js';
import { DesktopRemoteAccess } from '../src/main/remote-access.ts';
import type { RemoteCredentialsFile } from '../src/main/remote-access-credentials.ts';
import { defaultRemoteConfig, parseRemoteCredentials, parseRemoteRelayRoutes, type RemoteRelayRoutes } from '../src/shared/remote-access.ts';

test('desktop keeps its internal connection while QR and LAN receipts authorize only advertised phone routes', async () => {
  const routes: RemoteRelayRoutes = { id: 'relay_instance_test', endpoints: [
    { origin: 'https://203.0.113.9:9443', network: 'public' },
    { origin: 'https://10.80.0.9:8443', network: 'private' },
  ] };
  const refreshed: RemoteRelayRoutes = { ...routes, endpoints: [...routes.endpoints, { origin: 'https://10.90.0.9:8443', network: 'private' }] };
  let advertise = true;
  let inviteAvailable = true, bindCalls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Consume the isolated fixture request. */ }
    const metadata = advertise ? { relayRoutes: req.url === '/v1/register' ? routes : refreshed } : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/register') res.end(JSON.stringify({ deviceId: 'device_test', deviceToken: 'device_token_test', ...metadata }));
    else if (req.url === '/v1/invite') {
      if (!inviteAvailable) res.statusCode = 503;
      res.end(JSON.stringify({ inviteId: 'invite_test', claimSecret: 'claim_secret_test', expiresAt: Date.now() + 120000, ...metadata }));
    } else if (req.url === '/v1/bind') {
      bindCalls++;
      res.end(JSON.stringify({ bindingId: 'binding_test', bindingToken: 'binding_token_test', relayRoutes: { id: routes.id, endpoints: [{ origin: 'https://not-in-qr.example', network: 'public' }] } }));
    }
    else res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  let saved: any, qr: any;
  const file = { available: () => true, load: async () => ({ config: { ...defaultRemoteConfig(), relay: origin } }),
    save: async (config: unknown, credentials: unknown) => { saved = { config, credentials }; } } as unknown as RemoteCredentialsFile;
  const remote = new DesktopRemoteAccess(file, async () => {}, () => {});
  const generate = QRCode.toDataURL;
  QRCode.toDataURL = async (payload: string, options: any) => { qr = JSON.parse(payload); return generate(payload, options); };
  try {
    await remote.restore();
    await remote.act({ type: 'register', code: 'c'.repeat(43) });
    assert.deepEqual(saved.credentials.relayRoutes, routes);
    remote.update({ status: 'online', lan: { origins: ['http://192.168.2.75:34567'], connections: [] } });
    await remote.act({ type: 'pair' });
    assert.equal(qr.version, 2);
    assert.equal(qr.relay.origin, 'https://10.80.0.9:8443');
    assert.deepEqual(qr.relay.routes, refreshed);
    assert.equal(saved.credentials.relay, origin);
    assert.equal(remote.state.config.relay, origin);
    assert.deepEqual(parseRemoteCredentials(saved.credentials).relayRoutes, refreshed);
    assert.ok(Buffer.byteLength(JSON.stringify(qr)) < 1500, 'Representative mapped QR remains bounded');
    const credential = await remote.localAction({ type: 'pair', inviteId: qr.lan.inviteId, name: 'LAN phone' }) as any;
    assert.equal(credential.relay, qr.relay.origin);
    assert.deepEqual(credential.relayRoutes, qr.relay.routes, 'LAN receipt cannot add an endpoint absent from the scanned QR');
    advertise = false;
    await remote.act({ type: 'pair' });
    assert.equal(qr.relay.origin, origin);
    assert.equal(qr.relay.routes, undefined);
    assert.equal(saved.credentials.relayRoutes, undefined);
    inviteAvailable = false;
    await remote.act({ type: 'pair' });
    assert.equal(qr.relay, undefined);
    const before = bindCalls;
    const lanOnly = await remote.localAction({ type: 'pair', inviteId: qr.lan.inviteId, name: 'LAN-only phone' }) as any;
    assert.equal(lanOnly.relay, undefined);
    assert.equal(lanOnly.relayRoutes, undefined);
    assert.equal(lanOnly.bindingToken, '');
    assert.equal(bindCalls, before, 'A LAN-only QR does not authorize binding at an unadvertised relay');
  } finally { QRCode.toDataURL = generate; remote.stop(); await new Promise<void>(r => server.close(() => r())); }
});

test('stored and advertised mappings reject invalid identity, duplicates, credentials and non-HTTPS network addresses', () => {
  assert.equal(parseRemoteRelayRoutes(undefined), undefined);
  for (const value of [null, {}, { id: 'bad', endpoints: [] },
    { id: 'relay_test', endpoints: [{ origin: 'http://10.1.2.3:8443', network: 'private' }] },
    { id: 'relay_test', endpoints: [{ origin: 'https://u:p@example.test', network: 'public' }] },
    { id: 'relay_test', endpoints: [{ origin: 'https://example.test', network: 'auto' }] },
    { id: 'relay_test', endpoints: [{ origin: 'https://example.test', network: 'private' }, { origin: 'https://example.test/', network: 'public' }] },
  ]) assert.throws(() => parseRemoteRelayRoutes(value));
});
