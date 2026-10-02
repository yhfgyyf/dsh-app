import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { CollabStore } from './collab-store.js';
import { verifyCollabGrant, requireCollabSecret } from './collab-auth.js';
import { CollabError, COLLAB_PROTOCOL, MAX_ATTACHMENT_BYTES, idField, numberField, record, type CollabIdentity, type CollabPeer } from './collab-types.js';

export type CollabAuthorizer = (token: string) => Promise<CollabIdentity>;
export function relayAuthorizer(origin: string, secret: string): CollabAuthorizer {
  requireCollabSecret(secret);
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid relay internal origin');
  return async token => {
    const identity = verifyCollabGrant(token, secret);
    let res: Response;
    try { res = await fetch(url.origin + '/v1/collab-validate', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }); }
    catch { throw new CollabError(503, 'relay_auth_unavailable'); }
    if (!res.ok) { await res.body?.cancel(); throw new CollabError(res.status === 401 || res.status === 403 ? 403 : 503, res.status === 403 ? 'access_revoked' : 'relay_auth_unavailable'); }
    const body = await res.text();
    if (body.length > 4096) throw new CollabError(503, 'invalid_auth_response');
    const checked = JSON.parse(body) as CollabIdentity;
    if (checked.deviceId !== identity.deviceId || checked.kind !== identity.kind || checked.bindingId !== identity.bindingId || checked.role !== identity.role || checked.expiresAt !== identity.expiresAt) throw new CollabError(403, 'identity_mismatch');
    return identity;
  };
}

/** Independent HTTP/WS service. Relay binding validation precedes every data response. */
export function createCollabServer(store: CollabStore, authorize: CollabAuthorizer) {
  const sockets = new Set<{ ws: WebSocket; token: string; peer?: CollabPeer; sending: boolean; dirty: boolean }>();
  const rates = new Map<string, { at: number; count: number }>();
  const rate = (key: string, limit: number) => {
    const now = Date.now();
    let r = rates.get(key);
    if (!r || r.at + 60_000 < now) { r = { at: now, count: 0 }; rates.set(key, r); }
    if (++r.count > limit || rates.size > 10000) throw new CollabError(429, 'rate_limited');
  };
  const bearer = (req: IncomingMessage) => req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const sendChanged = async (client: { ws: WebSocket; token: string; peer?: CollabPeer; sending: boolean; dirty: boolean }) => {
    client.dirty = true;
    if (client.sending || !client.peer) return;
    client.sending = true;
    try {
      while (client.dirty && client.ws.readyState === WebSocket.OPEN) {
        client.dirty = false;
        const identity = await authorize(client.token), peer = store.peer(identity);
        if (peer.id !== client.peer.id) throw new CollabError(403, 'identity_mismatch');
        if (client.ws.bufferedAmount > 1024 * 1024) { client.ws.close(1013, 'backpressure'); break; }
        client.ws.send(JSON.stringify({ type: 'changed', cursor: store.cursor(), unread: store.unread(peer) }));
      }
    } catch { client.ws.close(4003, 'reauthenticate'); }
    finally { client.sending = false; }
  };
  const broadcast = () => { for (const client of sockets) void sendChanged(client); };
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value));
    };
    try {
      rate('ip:' + req.socket.remoteAddress, 2400);
      if (req.headers.origin) throw new CollabError(403, 'native_client_required');
      if (req.url === '/health' && req.method === 'GET') return reply(200, { ok: true, protocol: COLLAB_PROTOCOL });
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith('/collab/v1/')) throw new CollabError(404, 'not_found');
      const identity = await authorize(bearer(req));
      const method = req.method, parts = url.pathname.slice('/collab/v1/'.length).split('/');
      if (parts.length > 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new CollabError(404, 'not_found');
      let body: unknown = {};
      if (method === 'POST') {
        rate('write:' + identity.deviceId, 180);
        const max = parts[0] === 'attachments' ? Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4096 : 192 * 1024;
        if (Number(req.headers['content-length']) > max) throw new CollabError(413, 'request_too_large');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > max) throw new CollabError(413, 'request_too_large'); chunks.push(Buffer.from(chunk)); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new CollabError(400, 'invalid_json'); }
      } else if (method !== 'GET') throw new CollabError(405, 'method_not_allowed');
      if (parts[0] === 'join' && parts.length === 1 && method === 'POST') return reply(200, store.join(identity, body));
      const peer = store.peer(identity);
      const beforeCursor = store.cursor(), beforeUnread = method === 'POST' ? store.unread(peer) : 0;
      const write = () => { if (identity.kind !== 'desktop' || identity.role !== 'control') throw new CollabError(403, 'desktop_write_required'); };
      const query = Object.fromEntries(url.searchParams);
      let result: unknown;
      if (parts[0] === 'me' && parts.length === 1) {
        if (method === 'GET') result = { peer, protocol: COLLAB_PROTOCOL, unread: store.unread(peer) };
        else { write(); result = store.updateProfile(peer, body); }
      } else if (parts[0] === 'tasks' && parts.length === 1) {
        if (method === 'GET') result = store.catalog(peer, { ...query, offset: Number(query.offset ?? 0) });
        else { write(); result = store.createTask(peer, body); }
      } else if (parts[0] === 'tasks' && parts[1]) {
        const id = idField(parts[1]);
        if (parts.length === 2 && method === 'GET') result = store.detail(peer, id, numberField(Number(query.offset ?? 0), 0, 1000000));
        else if (parts.length === 3 && parts[2] === 'history' && method === 'GET') result = store.history(peer, id, numberField(Number(query.offset ?? 0), 0, 1000000));
        else {
          write(); if (method !== 'POST') throw new CollabError(405, 'method_not_allowed');
          if (parts.length === 2) result = store.updateTask(peer, id, body);
          else if (parts[2] === 'replies') result = store.addReply(peer, id, body);
          else if (parts[2] === 'follow') result = store.setFollow(peer, id, body);
          else if (parts[2] === 'participate') result = store.participate(peer, id, body);
          else if (parts[2] === 'accept') result = store.accept(peer, id, body);
          else throw new CollabError(404, 'not_found');
        }
      } else if (parts[0] === 'sync' && parts.length === 1 && method === 'GET') result = store.sync(peer, numberField(Number(query.after ?? 0)));
      else if (parts[0] === 'inbox' && parts.length === 1 && method === 'GET') result = store.inbox(peer, numberField(Number(query.offset ?? 0), 0, 1000000));
      else if (parts[0] === 'inbox' && parts[1] === 'read' && parts.length === 2 && method === 'POST') result = store.markRead(peer, body);
      else if (parts[0] === 'attachments' && parts.length === 1 && method === 'POST') { write(); result = store.upload(peer, body); }
      else if (parts[0] === 'attachments' && parts.length === 2 && method === 'GET') result = store.download(peer, idField(parts[1]));
      else throw new CollabError(404, 'not_found');
      reply(200, result);
      if (method === 'POST') {
        if (store.cursor() !== beforeCursor) broadcast();
        else if (store.unread(peer) !== beforeUnread) for (const client of sockets) if (client.peer?.id === peer.id) void sendChanged(client);
      }
    } catch (error) {
      if (error instanceof CollabError) reply(error.status, { error: error.code });
      else reply(500, { error: 'collaboration_failed' });
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    try {
      rate('ws:' + req.socket.remoteAddress, 120);
      if (req.url !== '/collab/v1/events' || req.headers.origin || sockets.size >= 1024) throw new Error();
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    } catch { socket.destroy(); }
  });
  wss.on('connection', (ws: WebSocket) => {
    const client = { ws, token: '', peer: undefined as CollabPeer | undefined, sending: false, dirty: false };
    sockets.add(client); let authenticating = false, alive = true;
    const timer = setTimeout(() => ws.close(4001, 'auth_timeout'), 5000);
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); if (client.peer) void sendChanged(client); } }, 30000);
    ws.on('pong', () => { alive = true; });
    ws.on('error', () => {});
    ws.on('message', raw => {
      if (authenticating) { ws.close(4003, 'auth_in_progress'); return; }
      authenticating = true;
      void (async () => {
        const data = record(JSON.parse(raw.toString()));
        if (data.type !== 'auth' || typeof data.token !== 'string') throw new CollabError(401, 'auth_required');
        const identity = await authorize(data.token), peer = store.peer(identity);
        if (client.peer && client.peer.id !== peer.id) throw new CollabError(403, 'identity_mismatch');
        client.token = data.token; client.peer = peer; clearTimeout(timer);
        if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'ready', protocol: COLLAB_PROTOCOL, expiresAt: identity.expiresAt })); await sendChanged(client); }
      })().catch(() => ws.close(4003, 'invalid_grant')).finally(() => { authenticating = false; });
    });
    ws.on('close', () => { clearTimeout(timer); clearInterval(heartbeat); sockets.delete(client); });
  });
  const cleanup = setInterval(() => { for (const [key, r] of rates) if (r.at + 60_000 < Date.now()) rates.delete(key); }, 60000);
  cleanup.unref();
  return { server, broadcast, close: async () => { clearInterval(cleanup); for (const { ws } of sockets) ws.terminate(); await new Promise<void>(r => server.close(() => r())); wss.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const secret = process.env.COLLAB_AUTH_SECRET;
  requireCollabSecret(secret);
  const dbPath = resolve(process.env.COLLAB_DB_PATH ?? 'data/collab.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const store = new CollabStore(dbPath); chmodSync(dbPath, 0o600);
  const app = createCollabServer(store, relayAuthorizer(process.env.RELAY_INTERNAL_URL ?? 'http://127.0.0.1:8787', secret));
  app.server.listen(Number(process.env.COLLAB_PORT ?? 8788), process.env.HOST ?? '127.0.0.1', () => console.log('DSH collaboration ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => { store.db.close(); process.exit(0); }); });
}
