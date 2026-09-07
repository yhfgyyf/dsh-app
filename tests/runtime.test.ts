import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { availableDesktopPort } from '../src/main/runtime.ts';

test('desktop reuses its port and selects a new one when another process owns it', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await availableDesktopPort(port), 0);
    assert.equal(server.listening, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.equal(await availableDesktopPort(port), port);
  assert.equal(await availableDesktopPort(0), 0);
});
