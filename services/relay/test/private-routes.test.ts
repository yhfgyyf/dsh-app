import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrivateStore } from '../src/private-store.js';
import { createPrivateRelay } from '../src/private-server.js';

const endpoints = [
  { origin: 'https://10.80.0.9:8443', network: 'private' },
  { origin: 'https://203.0.113.9:9443', network: 'public' },
];

test('one relay advertises phone mappings independently of its desktop address and request headers', async () => {
  const store = new PrivateStore(':memory:');
  const relay = createPrivateRelay(store, 'https://10.35.187.99:8443', { clientEndpoints: endpoints });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const origin = `http://127.0.0.1:${(relay.server.address() as any).port}`;
  const post = async (path: string, body: object, token?: string) => {
    const response = await fetch(`${origin}/v1/${path}`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-forwarded-host': 'untrusted.example',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 201); return response.json() as Promise<any>;
  };
  try {
    const health = await (await fetch(origin + '/health')).json() as any;
    assert.match(health.relayId, /^[A-Za-z0-9_-]{43}$/);
    store.provision('routes@example.test', 'test-password-long');
    const registered = await post('register', { code: store.registration('routes@example.test'), name: 'Internal desktop' });
    const expected = { id: health.relayId, endpoints };
    assert.deepEqual(registered.relayRoutes, expected);
    const invite = await post('invite', { deviceId: registered.deviceId, qr: true }, registered.deviceToken);
    assert.deepEqual(invite.relayRoutes, expected);
    const bound = await post('bind', { deviceId: registered.deviceId, name: 'LAN phone' }, registered.deviceToken);
    assert.deepEqual(bound.relayRoutes, expected);
    assert.equal(JSON.stringify(expected).includes('10.35.187.99'), false);
  } finally { await relay.close(); store.db.close(); }
});

test('relay identity survives restart and a deployment without mappings keeps legacy responses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-relay-routes-'));
  let store = new PrivateStore(join(dir, 'relay.db'));
  let relay: ReturnType<typeof createPrivateRelay> | undefined;
  try {
    const id = store.relayId;
    assert.match(id, /^[A-Za-z0-9_-]{43}$/);
    store.provision('legacy@example.test', 'test-password-long');
    const code = store.registration('legacy@example.test');
    store.db.close(); store = new PrivateStore(join(dir, 'relay.db'));
    assert.equal(store.relayId, id);
    relay = createPrivateRelay(store, 'https://relay.example.test');
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    const response = await fetch(`http://127.0.0.1:${(relay.server.address() as any).port}/v1/register`, {
      method: 'POST', body: JSON.stringify({ code, name: 'Legacy desktop' }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(await response.json() as object).sort(), ['deviceId', 'deviceToken']);
  } finally { await relay?.close(); store.db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('client mappings fail closed on malformed, ambiguous or insecure addresses', () => {
  const store = new PrivateStore(':memory:');
  try {
    for (const invalid of [[], {}, [{ origin: 'http://10.1.2.3', network: 'private' }],
      [{ origin: 'https://u:p@example.test', network: 'public' }],
      [{ origin: 'https://example.test/path', network: 'public' }],
      [{ origin: 'https://example.test?token=x', network: 'public' }],
      [{ origin: 'https://example.test', network: 'auto' }],
      [endpoints[0], { ...endpoints[0], origin: endpoints[0].origin + '/' }],
      Array.from({ length: 7 }, (_, i) => ({ origin: `https://10.1.2.${i + 1}`, network: 'private' })),
    ]) assert.throws(() => createPrivateRelay(store, 'https://relay.example.test', { clientEndpoints: invalid }));
  } finally { store.db.close(); }
});
