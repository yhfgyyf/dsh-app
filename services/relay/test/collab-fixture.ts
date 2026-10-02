import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PrivateStore } from '../src/private-store.js';
import { createPrivateRelay } from '../src/private-server.js';
import { CollabStore } from '../src/collab-store.js';
import { createCollabServer, relayAuthorizer } from '../src/collab-server.js';

export async function collaborationFixture(options: { rejectCollaborationWebSocket?: boolean } = {}) {
  const listen = async (server: Server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as any).port}`; };
  const secret = 'isolated-collaboration-fixture-secret';
  const relayStore = new PrivateStore(':memory:'), store = new CollabStore(':memory:');
  relayStore.provision('fixture@example.test', 'fixture-password-long');
  const devices = ['desktop-A', 'desktop-B', 'desktop-C'].map(name => relayStore.register(relayStore.registration('fixture@example.test'), name)!);
  const code = relayStore.registration('fixture@example.test');
  const relay = createPrivateRelay(relayStore, 'http://127.0.0.1:8787', { collabSecret: secret });
  const relayOrigin = await listen(relay.server);
  const collaboration = createCollabServer(store, relayAuthorizer(relayOrigin, secret));
  const collabOrigin = await listen(collaboration.server);
  const stats = { collaborationUpgrades: 0, attachmentUploads: 0 };
  let replyFromPeer: (() => Promise<unknown>) | undefined, dropNextReplyResponse = false;
  const gateway = createServer((req, res) => {
    if (req.url === '/__fixture/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...stats, attachments: store.db.prepare('SELECT COUNT(*) AS count FROM collab_attachments').get() })); return; }
    if (req.url === '/__fixture/drop-next-reply' && req.method === 'POST') { req.resume(); dropNextReplyResponse = true; res.end('{}'); return; }
    if (req.url === '/__fixture/peer-reply' && req.method === 'POST' && replyFromPeer) { req.resume(); void replyFromPeer().then(value => res.end(JSON.stringify(value)), () => { res.writeHead(500); res.end('{}'); }); return; }
    if (req.url === '/collab/v1/attachments' && req.method === 'POST') stats.attachmentUploads++;
    const dropReply = dropNextReplyResponse && req.method === 'POST' && /\/collab\/v1\/tasks\/[^/]+\/replies$/.test(req.url!);
    if (dropReply) dropNextReplyResponse = false;
    const target = new URL(req.url!, req.url!.startsWith('/collab/') ? collabOrigin : relayOrigin);
    const upstream = request(target, { method: req.method, headers: req.headers }, reply => {
      if (dropReply && reply.statusCode === 200) { reply.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"fixture_response_lost"}'); return; }
      res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  gateway.on('upgrade', (req, socket, head) => {
    if (req.url === '/collab/v1/events') {
      stats.collaborationUpgrades++;
      if (options.rejectCollaborationWebSocket) { socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'); return; }
    }
    const target = new URL(req.url!, req.url!.startsWith('/collab/') ? collabOrigin : relayOrigin);
    const upstream = request(target, { headers: req.headers });
    upstream.on('upgrade', (res, stream, initial) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (initial.length) socket.write(initial); if (head.length) stream.write(head);
      stream.pipe(socket).pipe(stream); socket.on('error', () => stream.destroy()); stream.on('error', () => socket.destroy());
    });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  const origin = await listen(gateway);
  const tokens = await Promise.all(devices.map(async device => {
    const res = await fetch(origin + '/v1/collab-token', { method: 'POST', headers: { authorization: 'Bearer ' + device.deviceToken }, body: JSON.stringify({ deviceId: device.deviceId }) });
    return (await res.json()).token as string;
  }));
  async function call(index: number, path: string, body?: unknown) {
    const res = await fetch(origin + '/collab/v1/' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + tokens[index], 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await res.json(); if (!res.ok) throw new Error(`Fixture API ${path}: ${res.status} ${JSON.stringify(result)}`); return result;
  }
  // The actual desktop owns B's identity. A and C exercise independent peers.
  const a = await call(0, 'join', { id: randomUUID(), nickname: '任务发布者' });
  const c = await call(2, 'join', { id: randomUUID(), nickname: '第三个节点' });
  const task = await call(0, 'tasks', { operationId: randomUUID(), title: '验证协作中的缓存 Token 统计', description: '在隔离环境读取本任务，给出解决步骤。此任务用于验证跨节点求助流程。', acceptance: '展示输入、缓存读取、缓存写入与输出，并由发布者验收。', tags: ['协作测试', 'Token'] });
  replyFromPeer = () => call(2, `tasks/${task.id}/replies`, { operationId: randomUUID(), actor: 'user', kind: 'message', body: '另一个节点已补充复现信息。', baseRevision: 1 });
  return { origin, code, devices, tokens, task, a, c, call, relayStore, store, stats,
    close: async () => { await collaboration.close(); await relay.close(); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); store.db.close(); relayStore.db.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await collaborationFixture({ rejectCollaborationWebSocket: process.env.DSH_COLLAB_FIXTURE_REJECT_WS === '1' });
  console.log(JSON.stringify({ origin: fixture.origin, code: fixture.code, taskId: fixture.task.id }));
  process.stdin.resume(); process.stdin.once('end', () => { void fixture.close(); });
}
