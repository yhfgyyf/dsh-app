import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { collabJson, createCollabBroker } from '../src/runtime/collab-transport.ts';
import type { RemoteCredentials } from '../src/shared/remote-access.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

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

test('in-place credential changes cannot mutate an in-flight grant or reuse its cache', async () => {
  const entered = deferred();
  let response: ServerResponse | undefined, requests = 0;
  const server = createServer((_request, res) => {
    requests++;
    if (requests === 1) { response = res; entered.resolve(); }
    else res.end(JSON.stringify({ token: 'new-grant', expiresAt: Date.now() + 300000 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const credentials: RemoteCredentials = { relay: `http://127.0.0.1:${(server.address() as any).port}`, deviceId: 'old-device', deviceToken: 'old-token', bindings: [] };
  const broker = createCollabBroker(() => credentials);
  try {
    const old = assert.rejects(broker.grant(), /中继配置已变化/); await entered.promise;
    credentials.deviceId = 'new-device'; credentials.deviceToken = 'new-token';
    response!.end(JSON.stringify({ token: 'old-grant', expiresAt: Date.now() + 300000 })); await old;
    const current = await broker.grant(); assert.equal(current.deviceId, 'new-device'); assert.equal(current.token, 'new-grant');
    assert.deepEqual(await broker.grant(), current); assert.equal(requests, 2);
    credentials.deviceToken = 'rotated-token'; await broker.grant(); assert.equal(requests, 3);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const status of [404, 405, 503]) test(`a non-JSON HTTP ${status} retains its status and reports unsupported only for a missing auth endpoint`, async () => {
  const server = createServer((_request, response) => { response.writeHead(status); response.end('<html>private-server-text</html>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${(server.address() as any).port}`;
  const broker = createCollabBroker(() => ({ relay, deviceId: 'fixture-device', deviceToken: 'fixture-token', bindings: [] }));
  try {
    await assert.rejects(broker.grant(), (error: any) => {
      assert.equal(error.status, status); assert.equal(error.code, status === 503 ? undefined : 'collaboration_not_supported');
      assert.equal(error.message.includes('private-server-text'), false); return true;
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a network failure is never reported as an unsupported relay', async () => {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${(server.address() as any).port}`; await new Promise<void>(resolve => server.close(() => resolve()));
  const broker = createCollabBroker(() => ({ relay, deviceId: 'fixture-device', deviceToken: 'fixture-token', bindings: [] }));
  await assert.rejects(broker.grant(), (error: any) => { assert.notEqual(error.code, 'collaboration_not_supported'); return true; });
});

test('server errors cannot echo a recovery key or authorization token into public errors', async () => {
  let code = 'fixturetoken';
  const server = createServer((_request, response) => { response.writeHead(409); response.end(JSON.stringify({ error: code })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const secret of ['fixturetoken', 'fixturesecret']) {
      code = secret;
      await assert.rejects(collabJson(relay + '/join', 'fixturetoken', { recoverySecret: 'fixturesecret' }), (error: any) => {
        assert.equal(error.status, 409); assert.equal(error.code, undefined); assert.equal(error.message.includes(secret), false); return true;
      });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
