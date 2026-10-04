import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { createCollabBroker } from '../src/runtime/collab-transport.ts';
import type { RemoteCredentials } from '../src/shared/remote-access.ts';

test('registration gates grants and revocation rejects a grant already in flight', async () => {
  let credentials: RemoteCredentials | undefined, respond: ServerResponse | undefined, requests = 0;
  const server = createServer((_req, res) => { requests++; respond = res; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const broker = createCollabBroker(() => credentials);
  try {
    assert.equal(broker.isRegistered(), false);
    await assert.rejects(broker.grant(), /插件 → dsh-p2p-collab/);
    assert.equal(requests, 0);
    credentials = { relay: `http://127.0.0.1:${(server.address() as any).port}`, deviceId: 'fixture-device', deviceToken: 'fixture-token', bindings: [] };
    assert.equal(broker.isRegistered(), true);
    const pending = assert.rejects(broker.grant(), /中继配置已变化/);
    for (let i = 0; !respond && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(respond);
    credentials = undefined;
    assert.equal(broker.isRegistered(), false);
    respond.end(JSON.stringify({ token: 'revoked-fixture-grant', expiresAt: Date.now() + 300000 }));
    await pending;
    await assert.rejects(broker.grant(), /注册中继/);
    assert.equal(requests, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('grant caching compares credential values and a superseded request cannot clear the current generation', async () => {
  const requests: { deviceId: string; response: ServerResponse }[] = [];
  const server = createServer(async (req, response) => { let body = ''; for await (const chunk of req) body += chunk; requests.push({ deviceId: JSON.parse(body).deviceId, response }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${(server.address() as any).port}`;
  let device = 'fixture-device-one';
  const broker = createCollabBroker(() => ({ relay, deviceId: device, deviceToken: 'fixture-only-token', bindings: [] }));
  const settle = (index: number) => requests[index].response.end(JSON.stringify({ token: 'grant-' + requests[index].deviceId, expiresAt: Date.now() + 300000 }));
  const until = async (count: number) => { for (let i = 0; i < 100 && requests.length < count; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(requests.length, count); };
  try {
    const old = broker.grant().then(value => ({ value }), error => ({ error })); await until(1);
    device = 'fixture-device-two'; const current = broker.grant(); await until(2);
    settle(0); assert.ok('error' in await old);
    const same = broker.grant(); settle(1);
    assert.deepEqual(await same, await current);
    assert.deepEqual(await broker.grant(), await current);
    assert.equal(requests.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
