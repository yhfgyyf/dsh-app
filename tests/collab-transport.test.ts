import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { createCollabBroker } from '../src/runtime/collab-transport.ts';

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
