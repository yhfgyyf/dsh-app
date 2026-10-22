import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:net';
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

test('desktop selects a new port when Windows denies its cached port', async t => {
  const error = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:61506'), { code: 'EACCES' });
  t.mock.method(Server.prototype, 'listen', function (this: Server) {
    queueMicrotask(() => this.emit('error', error));
    return this;
  });
  assert.equal(await availableDesktopPort(61506), 0);
});

test('desktop does not hide unrelated socket failures', async t => {
  const error = Object.assign(new Error('Too many open files'), { code: 'EMFILE' });
  t.mock.method(Server.prototype, 'listen', function (this: Server) {
    queueMicrotask(() => this.emit('error', error));
    return this;
  });
  await assert.rejects(availableDesktopPort(61506), value => value === error);
});

test('desktop recovers from a real Windows excluded port', { skip: !process.env.DSH_TEST_EXCLUDED_PORT }, async () => {
  assert.equal(process.platform, 'win32');
  const port = Number(process.env.DSH_TEST_EXCLUDED_PORT);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  const blocked = createServer();
  await assert.rejects(new Promise<void>((resolve, reject) => {
    blocked.once('error', reject);
    blocked.listen(port, '127.0.0.1', resolve);
  }), { code: 'EACCES' });
  const fallback = await availableDesktopPort(port);
  assert.equal(fallback, 0);
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(fallback, '127.0.0.1', resolve);
    });
    assert.notEqual((server.address() as { port: number }).port, port);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
