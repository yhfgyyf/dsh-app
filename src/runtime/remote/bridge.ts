import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { acceptClientHello, type SecureCipher } from './e2ee.ts';
import { permittedMux, permittedPath } from './policy.ts';
import type { RemoteRuntimeConfig, RemoteBinding } from '../../shared/remote-access.ts';

const CHUNK = 48 * 1024, MAX_FILE = 256 * 1024 * 1024, MAX_BUFFER = 4 * 1024 * 1024;
type Tunnel = { cipher: SecureCipher; binding: RemoteBinding; sockets: Map<string, any>; requests: Map<string, { request: ClientRequest; length: number; received: number; seq: number; writing: boolean; responseAck?: { seq: number; resolve: () => void } }> };

/** One outgoing connection, attached to the app-owned loopback Host; never opens a listener. */
export class RemoteBridge {
  private socket: any;
  private retry?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private attempts = 0;
  private authenticated = false;
  private sessions = new Map<string, Tunnel>();
  private config: RemoteRuntimeConfig = { enabled: false };
  private cookie = '';
  private WebSocket: any;
  private endpoint: string;
  private launchUrl: string;
  private publish: (state: { status: string; error?: string; connections?: string[] }) => void;
  constructor(WebSocket: any, endpoint: string, launchUrl: string, publish: (state: { status: string; error?: string; connections?: string[] }) => void) {
    this.WebSocket = WebSocket; this.endpoint = endpoint; this.launchUrl = launchUrl; this.publish = publish;
  }

  async configure(config: RemoteRuntimeConfig) {
    this.stop(); this.config = config;
    if (!config.enabled || !config.credentials) { this.publish({ status: 'disabled' }); return; }
    const generation = this.generation;
    this.publish({ status: 'connecting' });
    // Token and resulting cookie remain entirely inside this local process.
    const response = await fetch(this.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    this.cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    await response.body?.cancel();
    if (!this.cookie) throw new Error('本机 Host 认证失败。');
    if (generation === this.generation) this.connect(generation);
  }
  stop() {
    this.authenticated = false;
    this.generation++; clearTimeout(this.retry); this.retry = undefined;
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    this.socket?.terminate(); this.socket = undefined; this.cookie = ''; this.attempts = 0;
  }
  private connect(generation: number) {
    const credentials = this.config.credentials!;
    const socket = this.socket = new this.WebSocket(credentials.relay.replace(/^http/, 'ws') + '/v1/device', { maxPayload: 256 * 1024, perMessageDeflate: false, handshakeTimeout: 10000 });
    let authenticated = false;
    let lastReceived = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - lastReceived > 70000) socket.terminate(); }, 15000);
    socket.on('ping', () => { lastReceived = Date.now(); });
    const timer = setTimeout(() => socket.terminate(), 10000);
    socket.on('open', () => this.send({ type: 'auth', deviceId: credentials.deviceId, deviceToken: credentials.deviceToken }));
    socket.on('message', (raw: Buffer) => {
      if (generation !== this.generation) return;
      lastReceived = Date.now();
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'auth_ok') { clearTimeout(timer); authenticated = true; this.authenticated = true; this.attempts = 0; this.publishConnections(); return; }
        if (!authenticated) throw new Error('auth_required');
        if (m.type === 'client_close') { this.closeSession(m.accessSessionId, false); return; }
        if (m.type === 'client_hello') {
          const binding = credentials.bindings.find(b => b.id === m.bindingId && !b.revoked);
          if (!binding || this.sessions.size >= 32 || this.sessions.has(m.accessSessionId)) throw new Error('unapproved_binding');
          const accepted = acceptClientHello(binding.key, m);
          this.sessions.set(m.accessSessionId, { cipher: accepted.cipher, binding, sockets: new Map(), requests: new Map() });
          this.send({ type: 'server_hello', ...accepted.hello }); this.publishConnections(); return;
        }
        if (m.type !== 'sealed') throw new Error('invalid_frame');
        const session = this.sessions.get(m.accessSessionId); if (!session) throw new Error('no_session');
        this.handle(m.accessSessionId, session, session.cipher.open(m) as any);
      } catch { if (typeof JSONSafeSession(raw) === 'string') this.closeSession(JSONSafeSession(raw)!); else socket.close(4003, 'invalid_frame'); }
    });
    socket.on('error', () => { if (generation !== this.generation) return; this.publish({ status: 'reconnecting', error: '中继连接失败，请检查地址、网络及证书。' }); });
    socket.on('close', () => {
      clearTimeout(timer); clearInterval(watchdog);
      if (generation !== this.generation) return;
      this.authenticated = false;
      for (const id of [...this.sessions.keys()]) this.closeSession(id, false);
      this.publish({ status: 'reconnecting', error: authenticated ? undefined : '中继尚未完成认证。' });
      this.retry = setTimeout(() => this.connect(generation), Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)) + Math.random() * 500);
    });
  }
  private publishConnections() { if (this.authenticated) this.publish({ status: 'online', connections: [...new Set([...this.sessions.values()].map(s => s.binding.id))] }); }
  private send(value: unknown) {
    if (!this.socket || this.socket.readyState !== 1) return;
    if (this.socket.bufferedAmount > MAX_BUFFER) { this.socket.terminate(); return; }
    this.socket.send(JSON.stringify(value));
  }
  private inner(id: string, value: unknown) {
    const s = this.sessions.get(id); if (s) this.send({ type: 'sealed', accessSessionId: id, ...s.cipher.seal(value) });
  }
  private closeSession(id: string, notify = true) {
    const s = this.sessions.get(id); this.sessions.delete(id);
    if (s) { for (const ws of s.sockets.values()) ws.terminate(); for (const r of s.requests.values()) { r.responseAck?.resolve(); r.request.destroy(); } }
    if (notify) this.send({ type: 'device_close', accessSessionId: id });
    this.publishConnections();
  }
  private handle(id: string, s: Tunnel, m: any) {
    if (!m || typeof m.channel !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(m.channel)) throw new Error('invalid_channel');
    const channel = m.channel;
    if (m.type === 'http_open') {
      if (s.requests.size >= 8 || s.requests.has(channel)) throw new Error('request_limit');
      const path = permittedPath(m.method, m.path, s.binding.role);
      if (!Number.isSafeInteger(m.length) || m.length < 0 || m.length > (path.startsWith('/api/session/uploadFileBinary?') || path === '/api/session/uploadFileBinary' ? MAX_FILE : 16 * 1024 * 1024)) throw new Error('size_limit');
      if (m.method === 'GET' && m.length !== 0) throw new Error('get_body');
      const headers: Record<string, string> = { cookie: this.cookie, origin: this.endpoint, 'content-length': String(m.length) };
      if (typeof m.contentType === 'string' && m.contentType.length < 256 && !/[\r\n]/.test(m.contentType)) headers['content-type'] = m.contentType;
      const req = httpRequest(this.endpoint + path, { method: m.method, headers, timeout: 120000 }, res => {
        let length = 0, seq = 0;
        this.inner(id, { type: 'http_head', channel, status: res.statusCode, contentType: res.headers['content-type'], contentDisposition: res.headers['content-disposition'] });
        void (async () => {
          try {
            for await (const value of res) {
              const chunk = Buffer.from(value); length += chunk.length;
              if (length > MAX_FILE) throw new Error('response_limit');
              for (let offset = 0; offset < chunk.length; offset += CHUNK) {
                if (!this.sessions.has(id)) throw new Error('closed');
                // Bounded queues: wait for the transport rather than buffer a whole attachment.
                while (this.socket?.readyState === 1 && this.socket.bufferedAmount > CHUNK * 2) await new Promise(r => setTimeout(r, 5));
                const current = s.requests.get(channel); if (!current) throw new Error('closed');
                await new Promise<void>((resolve, reject) => {
                  const timeout = setTimeout(() => reject(new Error('response_ack_timeout')), 30000);
                  current.responseAck = { seq, resolve: () => { clearTimeout(timeout); resolve(); } };
                  this.inner(id, { type: 'http_data', channel, seq: seq++, data: chunk.subarray(offset, offset + CHUNK).toString('base64') });
                });
              }
            }
            this.inner(id, { type: 'http_end', channel });
          } catch { this.inner(id, { type: 'http_error', channel, error: 'response_failed' }); }
          finally { s.requests.delete(channel); }
        })();
      });
      s.requests.set(channel, { request: req, length: m.length, received: 0, seq: 0, writing: false });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => { s.requests.delete(channel); this.inner(id, { type: 'http_error', channel, error: 'host_request_failed' }); });
      this.inner(id, { type: 'http_ack', channel, seq: -1 });
      return;
    }
    if (m.type === 'http_response_ack') {
      const r = s.requests.get(channel);
      if (!r?.responseAck || r.responseAck.seq !== m.seq) throw new Error('invalid_ack');
      r.responseAck.resolve(); r.responseAck = undefined; return;
    }
    if (m.type === 'http_data') {
      const r = s.requests.get(channel); if (!r || r.writing || m.seq !== r.seq++ || typeof m.data !== 'string' || m.data.length > CHUNK * 2) throw new Error('invalid_upload');
      const bytes = Buffer.from(m.data, 'base64'); r.received += bytes.length;
      if (r.received > r.length) throw new Error('upload_limit');
      r.writing = true;
      r.request.write(bytes, () => { r.writing = false; this.inner(id, { type: 'http_ack', channel, seq: m.seq }); }); return;
    }
    if (m.type === 'http_end') { const r = s.requests.get(channel); if (!r || r.writing || r.received !== r.length) throw new Error('length_mismatch'); r.request.end(); return; }
    if (m.type === 'http_close') { s.requests.get(channel)?.request.destroy(); s.requests.delete(channel); return; }
    if (m.type === 'ws_open') {
      if (s.sockets.size >= 2 || s.sockets.has(channel)) throw new Error('socket_limit');
      const socket = new this.WebSocket(this.endpoint.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { cookie: this.cookie, origin: this.endpoint }, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
      s.sockets.set(channel, socket);
      socket.on('open', () => this.inner(id, { type: 'ws_open', channel }));
      let eventClientId: string | undefined;
      let queuedBytes = 0;
      let delivery = Promise.resolve();
      socket.on('message', (value: Buffer) => {
        try {
          const frame = JSON.parse(value.toString());
          if (frame.type === 'item' && frame.value?.type === 'ready' && typeof frame.value.clientId === 'string') eventClientId = frame.value.clientId;
          if (frame.type === 'item' && frame.value?.type === 'emit' && /^(credentials|settings|plugin-manager|cordis|deepseek-account)\//.test(frame.value.event ?? '')) return;
          if (s.binding.role === 'viewer' && frame.type === 'item' && frame.value?.type === 'waterfall') {
            if (eventClientId) void fetch(this.endpoint + '/api/$events/result', { method: 'POST', headers: { cookie: this.cookie, origin: this.endpoint, 'content-type': 'application/json' },
              body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId: eventClientId, eventId: frame.value.eventId, outcome: { kind: 'next' } } } }), signal: AbortSignal.timeout(5000),
            }).then(r => r.body?.cancel()).catch(() => socket.close());
            return;
          }
        } catch { socket.close(); return; }
        // Large Host frames are split; each fragment remains authenticated and ordered.
        queuedBytes += value.length;
        if (queuedBytes > 8 * 1024 * 1024) { socket.terminate(); return; }
        socket.pause();
        delivery = delivery.then(async () => {
          for (let offset = 0; offset < value.length; offset += CHUNK) {
            while (this.socket?.readyState === 1 && this.socket.bufferedAmount > CHUNK * 2) await new Promise(r => setTimeout(r, 5));
            if (!this.sessions.has(id)) throw new Error('closed');
            this.inner(id, { type: 'ws_data', channel, data: value.subarray(offset, offset + CHUNK).toString('base64'), final: offset + CHUNK >= value.length });
          }
        }).catch(() => socket.close()).finally(() => { queuedBytes -= value.length; if (!queuedBytes && socket.readyState === 1) socket.resume(); });
      });
      socket.on('error', () => socket.close());
      socket.on('close', () => { s.sockets.delete(channel); this.inner(id, { type: 'ws_close', channel }); }); return;
    }
    if (m.type === 'ws_data') {
      if (typeof m.text !== 'string' || m.text.length > 128 * 1024) throw new Error('frame_limit');
      permittedMux(m.text, s.binding.role);
      const ws = s.sockets.get(channel);
      if (ws?.readyState !== 1 || ws.bufferedAmount > MAX_BUFFER) throw new Error('socket_unavailable');
      ws.send(m.text); return;
    }
    if (m.type === 'ws_close') { s.sockets.get(channel)?.close(); s.sockets.delete(channel); return; }
    throw new Error('unknown_message');
  }
}
function JSONSafeSession(raw: Buffer): string | undefined {
  try { const id = JSON.parse(raw.toString()).accessSessionId; return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : undefined; } catch { return undefined; }
}
