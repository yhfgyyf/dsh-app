import { createServer, type IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrivateStore, hash, token } from './private-store.js';
import { parseClientEndpoints } from './client-endpoints.js';

const FRAME_LIMIT = 256 * 1024;
const BUFFER_LIMIT = 4 * 1024 * 1024;
export function createPrivateRelay(store: PrivateStore, origin: string, options: { clientEndpoints?: unknown } = {}) {
  const publicUrl = new URL(origin);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password ||
      (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)))) throw new Error('PUBLIC_RELAY_URL must be an HTTPS origin');
  const routes = options.clientEndpoints === undefined ? {} : {
    relayRoutes: { id: store.relayId, endpoints: parseClientEndpoints(options.clientEndpoints) },
  };
  const devices = new Map<string, WebSocket>();
  const clients = new Map<string, { socket: WebSocket; device: string; binding: string }>();
  const accounts = new Map<string, { account: string; expires: number }>();
  const tickets = new Map<string, { device: string; binding: string; expires: number; session: string }>();
  const rates = new Map<string, { count: number; expires: number }>();
  const send = (socket: WebSocket | undefined, data: unknown) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > BUFFER_LIMIT) { socket.close(1013, 'backpressure'); return false; }
    socket.send(JSON.stringify(data)); return true;
  };
  const closeClients = (device: string, binding?: string) => {
    for (const [id, c] of clients) if (c.device === device && (!binding || c.binding === binding)) {
      clients.delete(id); c.socket.close(4003, 'access_closed'); send(devices.get(device), { type: 'client_close', accessSessionId: id });
    }
  };
  function bearer(req: IncomingMessage) { return req.headers.authorization?.replace(/^Bearer /, '') ?? ''; }
  function rate(req: IncomingMessage) {
    const key = req.socket.remoteAddress ?? 'unknown', now = Date.now();
    if (rates.size > 10000 && !rates.has(key)) return false;
    let value = rates.get(key);
    if (!value || value.expires <= now) { value = { count: 0, expires: now + 60000 }; rates.set(key, value); }
    return ++value.count <= 1200;
  }
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (!rate(req)) return reply(429, { error: 'rate_limited' });
      if (req.headers.origin) return reply(403, { error: 'native_client_required' });
      if (req.url === '/health' && req.method === 'GET') return reply(200, { protocol: 'dsh-desktop-remote-v1', ok: true, relayId: store.relayId });
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/')) return reply(404, { error: 'not_found' });
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) { reply(413, { error: 'too_large' }); req.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const str = (key: string, max = 128) => { const v = body[key]; if (typeof v !== 'string' || !v || v.length > max) throw new Error('invalid_input'); return v; };
      if (req.url === '/v1/login') {
        // A second, strict rate bucket bounds scrypt CPU cost independently of ordinary polling.
        const loginKey = `login:${req.socket.remoteAddress}`;
        const r = rates.get(loginKey);
        if (r && r.expires > Date.now() && r.count >= 10) return reply(429, { error: 'rate_limited' });
        rates.set(loginKey, { count: r && r.expires > Date.now() ? r.count + 1 : 1, expires: r && r.expires > Date.now() ? r.expires : Date.now() + 60000 });
        const email = str('email', 254);
        if (!store.login(email, str('password', 1024))) return reply(401, { error: 'invalid_credentials' });
        if (accounts.size > 10000) return reply(503, { error: 'busy' });
        const accessToken = token(); accounts.set(hash(accessToken), { account: email, expires: Date.now() + 600000 });
        return reply(200, { accessToken });
      }
      if (req.url === '/v1/register') {
        const result = store.register(str('code'), str('name', 80));
        return reply(result ? 201 : 403, result ? { ...result, ...routes } : { error: 'invalid_registration_code' });
      }
      if (req.url === '/v1/claim') {
        const account = accounts.get(hash(bearer(req)));
        if (!account || account.expires <= Date.now()) return reply(401, { error: 'login_required' });
        const result = store.claim(account.account, str('inviteId'), str('claimSecret'), str('name', 80));
        return reply(result ? 201 : 409, result ?? { error: 'invalid_invitation' });
      }
      if (req.url === '/v1/claim-qr') {
        const result = store.claimQr(str('inviteId'), str('claimSecret'), str('name', 80));
        return reply(result ? 201 : 409, result ?? { error: 'invalid_invitation' });
      }
      if (req.url === '/v1/unbind') {
        const binding = store.selfRevoke(str('bindingId'), bearer(req));
        if (!binding) return reply(403, { error: 'invalid_binding' });
        closeClients(binding.device, binding.id);
        for (const [key, t] of tickets) if (t.binding === binding.id && t.device === binding.device) tickets.delete(key);
        return reply(200, { ok: true });
      }
      if (['/v1/status', '/v1/ticket'].includes(req.url)) {
        const binding = store.binding(str('bindingId'), bearer(req));
        if (!binding) return reply(403, { error: 'binding_revoked_or_expired' });
        if (req.url === '/v1/status') return reply(200, { state: binding.state, role: binding.role });
        if (binding.state !== 'approved') return reply(403, { error: 'approval_required' });
        if (!devices.has(binding.device)) return reply(503, { error: 'desktop_offline' });
        if (tickets.size > 10000) return reply(503, { error: 'busy' });
        const ticket = token(), accessSessionId = token();
        tickets.set(hash(ticket), { device: binding.device, binding: binding.id, expires: Date.now() + 30000, session: accessSessionId });
        return reply(200, { ticket, accessSessionId, tunnelUrl: publicUrl.origin.replace(/^http/, 'ws') + '/v1/tunnel' });
      }
      const device = store.device(str('deviceId'), bearer(req));
      if (!device) return reply(401, { error: 'invalid_device_token' });
      if (req.url === '/v1/unregister') {
        closeClients(device.id); devices.get(device.id)?.close(4003, 'unregistered');
        store.db.transaction(() => {
          store.cancel(device.id);
          store.db.prepare('DELETE FROM remote_bindings WHERE device = ?').run(device.id);
          store.db.prepare('DELETE FROM remote_devices WHERE id = ?').run(device.id);
        })();
        return reply(200, { ok: true });
      }
      if (req.url === '/v1/invite') return reply(201, { ...store.invite(device.id, body.qr === true), ...routes });
      if (req.url === '/v1/bind') {
        const result = store.bind(device.id, str('name', 80));
        return reply(result ? 201 : 409, result ? { ...result, ...routes } : { error: 'binding_limit' });
      }
      if (req.url === '/v1/bindings') return reply(200, { bindings: store.bindingStates(device.id) });
      if (req.url === '/v1/cancel') { store.cancel(device.id); return reply(200, { ok: true }); }
      if (req.url === '/v1/pending') return reply(200, { pending: store.pending(device.id) });
      if (req.url === '/v1/approve') {
        const role = str('role'); if (!['viewer', 'control'].includes(role)) throw new Error('invalid_role');
        return reply(store.approve(device.id, str('bindingId'), role) ? 200 : 409, { ok: true });
      }
      if (req.url === '/v1/revoke') {
        const id = str('bindingId'); store.revoke(device.id, id); closeClients(device.id, id);
        for (const [key, t] of tickets) if (t.binding === id && t.device === device.id) tickets.delete(key);
        return reply(200, { ok: true });
      }
      reply(404, { error: 'not_found' });
    } catch { if (!res.headersSent) reply(400, { error: 'invalid_request' }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_LIMIT, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (!['/v1/device', '/v1/tunnel'].includes(req.url ?? '') || req.headers.origin || !rate(req) || wss.clients.size >= 2048) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let deviceId: string | undefined, sessionId: string | undefined;
    const timeout = setTimeout(() => ws.close(4001, 'auth_timeout'), 5000);
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 30000);
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (!deviceId && !sessionId) {
          if (m.type !== 'auth') throw new Error('auth_required');
          if (req.url === '/v1/device') {
            if (typeof m.deviceId !== 'string' || typeof m.deviceToken !== 'string') throw new Error('auth');
            const d = store.device(m.deviceId, m.deviceToken); if (!d) throw new Error('auth');
            const old = devices.get(d.id); if (old) { closeClients(d.id); old.close(4001, 'replaced'); }
            deviceId = d.id; devices.set(d.id, ws); send(ws, { type: 'auth_ok' });
          } else {
            if (typeof m.ticket !== 'string') throw new Error('ticket');
            const t = tickets.get(hash(m.ticket)); tickets.delete(hash(m.ticket));
            if (!t || t.expires <= Date.now() || !devices.has(t.device)) throw new Error('ticket');
            if ([...clients.values()].filter(c => c.device === t.device).length >= 64) throw new Error('capacity');
            sessionId = t.session; clients.set(t.session, { socket: ws, device: t.device, binding: t.binding });
            send(ws, { type: 'auth_ok', accessSessionId: sessionId });
          }
          clearTimeout(timeout); return;
        }
        if (deviceId) {
          if (!['server_hello', 'sealed', 'device_close'].includes(m.type)) throw new Error('frame');
          const c = clients.get(m.accessSessionId);
          if (!c || c.device !== deviceId) return;
          send(c.socket, m);
          if (m.type === 'device_close') { c.socket.close(4003, 'desktop_closed'); clients.delete(m.accessSessionId); }
        } else {
          const c = clients.get(sessionId!); if (!c) throw new Error('closed');
          if (!['client_hello', 'sealed'].includes(m.type) || m.accessSessionId !== sessionId) throw new Error('frame');
          // The sender cannot choose a different binding or target desktop.
          if (!send(devices.get(c.device), { ...m, bindingId: c.binding })) ws.close(1013, 'desktop_unavailable');
        }
      } catch { ws.close(4003, 'invalid_frame_or_credential'); }
    });
    ws.on('close', () => {
      clearTimeout(timeout); clearInterval(heartbeat);
      if (deviceId && devices.get(deviceId) === ws) { devices.delete(deviceId); closeClients(deviceId); }
      if (sessionId) { const c = clients.get(sessionId); clients.delete(sessionId); if (c) send(devices.get(c.device), { type: 'client_close', accessSessionId: sessionId }); }
    });
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const map of [accounts, tickets, rates]) for (const [key, value] of map) if (value.expires <= now) map.delete(key);
    store.db.prepare('DELETE FROM remote_codes WHERE expires < ?').run(now);
    store.db.prepare('DELETE FROM remote_invites WHERE expires < ?').run(now);
    // Revocations must survive an offline desktop; its LAN copy is revoked on the next sync.
    store.db.prepare("DELETE FROM remote_bindings WHERE state = 'pending' AND expires < ?").run(now - 86400000);
  }, 60000);
  cleanup.unref();
  return { server, close: async () => { clearInterval(cleanup); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => server.close(() => r())); wss.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const path = resolve(process.env.DB_PATH ?? 'data/private-relay.db');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = new PrivateStore(path); chmodSync(path, 0o600);
  if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_RELAY_URL?.startsWith('https://')) throw new Error('Production requires PUBLIC_RELAY_URL with HTTPS');
  const relay = createPrivateRelay(store, process.env.PUBLIC_RELAY_URL ?? 'http://127.0.0.1:8787', {
    clientEndpoints: process.env.RELAY_CLIENT_ENDPOINTS === undefined ? undefined : JSON.parse(process.env.RELAY_CLIENT_ENDPOINTS),
  });
  relay.server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1', () => console.log('DSH private relay ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void relay.close().then(() => { store.db.close(); process.exit(0); }); });
}
