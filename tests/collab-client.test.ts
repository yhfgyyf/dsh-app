import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollabClient } from '../src/runtime/collab-client.ts';

test('collaboration reads and writes on demand over HTTP with WebSocket unavailable, then recovers on the next request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-http-'));
  let joins = 0, upgrades = 0, grants = 0, failRead = false, writes = 0;
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!); let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/collab/v1/join') { joins++; res.end(JSON.stringify({ id: body.id, nickname: body.nickname, createdAt: 1 })); return; }
    if (!joins) { res.writeHead(403); res.end('{"error":"peer_not_joined"}'); return; }
    if (req.url!.startsWith('/collab/v1/sync?')) { res.end(JSON.stringify({ cursor: 2, unread: 1, hasMore: false })); return; }
    if (req.url === '/collab/v1/tasks' && req.method === 'POST') { writes++; res.end('{"id":"fixture-task"}'); return; }
    if (failRead) { failRead = false; res.writeHead(503); res.end('{"error":"temporary_failure"}'); return; }
    res.end('{"tasks":[]}');
  });
  server.on('upgrade', (_req, socket) => { upgrades++; socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const client = new CollabClient(home, { grant: async () => { grants++; return { origin, token: 'fixture-token', expiresAt: Date.now() + 300000 }; } });
  await client.restore();
  try {
    client.start(); assert.equal(grants, 0, 'Starting the plugin must not start presence or connection probes');
    await Promise.all([client.api('tasks'), client.api('tasks')]);
    assert.equal(joins, 1, 'Concurrent first reads must join only once');
    assert.equal(client.state().unread, 0);
    await client.sync(); assert.equal(client.state().unread, 1); assert.equal(client.state().cursor, 2);
    assert.ok(client.state().lastSyncAt);
    failRead = true; await assert.rejects(client.api('tasks'), /temporary_failure/);
    assert.deepEqual(await client.api('tasks'), { tasks: [] });
    assert.equal((await client.api('tasks', { title: 'Explicit user post' })).id, 'fixture-task');
    await client.sync(); assert.equal(writes, 1); assert.equal(joins, 1); assert.equal(upgrades, 0);
    assert.ok(paths.every(path => !path.includes('/events')));
  } finally { await client.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
