import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { acceptClientHello, type SecureCipher } from './e2ee.ts';
import { permittedMux, permittedPath, RemoteStreamDenied } from './policy.ts';
import type { RemoteBinding } from '../../shared/remote-access.ts';

const CHUNK = 48 * 1024, MAX_FILE = 256 * 1024 * 1024, MAX_BUFFER = 4 * 1024 * 1024;
type TunnelSocket = { socket: any; deliver: (value: Buffer) => void };
type Tunnel = { cipher: SecureCipher; binding: RemoteBinding; closing?: boolean; sockets: Map<string, TunnelSocket>; requests: Map<string, { request: ClientRequest; length: number; received: number; seq: number; writing: boolean; responseAck?: { seq: number; resolve: () => void } }> };

/** The same bounded, authorized Host forwarding is used for LAN and relay peers. */
export class HostTunnel {
  private cookie = '';
  private sessions = new Map<string, Tunnel>();
  private WebSocket: any;
  private endpoint: string;
  private launchUrl: string;
  private send: (id: string, frame: unknown) => void;
  private alive: (id: string) => boolean;
  private buffered: (id: string) => number;
  private changed: () => void;
  private unbind?: (bindingId: string) => Promise<void>;
  constructor(WebSocket: any, endpoint: string, launchUrl: string,
    send: (id: string, frame: unknown) => void, alive: (id: string) => boolean,
    buffered: (id: string) => number, changed: () => void,
    unbind?: (bindingId: string) => Promise<void>) {
    this.WebSocket = WebSocket; this.endpoint = endpoint; this.launchUrl = launchUrl;
    this.send = send; this.alive = alive; this.buffered = buffered; this.changed = changed; this.unbind = unbind;
  }
  async start() {
    const response = await fetch(this.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    this.cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    await response.body?.cancel();
    if (!this.cookie) throw new Error('本机 Host 认证失败。');
  }
  get size() { return this.sessions.size; }
  get bindingIds() { return [...new Set([...this.sessions.values()].map(s => s.binding.id))]; }
  has(id: string) { return this.sessions.has(id); }
  accept(id: string, binding: RemoteBinding, hello: any) {
    if (binding.revoked || this.sessions.has(id) || this.sessions.size >= 32) throw new Error('unapproved_binding');
    const accepted = acceptClientHello(binding.key, hello);
    this.sessions.set(id, { cipher: accepted.cipher, binding, sockets: new Map(), requests: new Map() });
    this.changed();
    return { type: 'server_hello', ...accepted.hello };
  }
  receive(id: string, frame: any) {
    const session = this.sessions.get(id);
    if (!session || session.closing) throw new Error('no_session');
    const message = session.cipher.open(frame) as any;
    if (message?.type === 'binding_unbind' && this.unbind) {
      session.closing = true;
      void this.unbind(session.binding.id).then(() => {
        this.inner(id, { type: 'binding_unbound' }); this.close(id);
      }, () => { this.inner(id, { type: 'binding_error' }); this.close(id); });
      return;
    }
    this.handle(id, session, message);
  }
  revokeMissing(bindings: RemoteBinding[]) {
    for (const [id, session] of this.sessions) if (!session.closing && !bindings.some(b => b.id === session.binding.id && !b.revoked && b.key === session.binding.key && b.role === session.binding.role)) this.close(id);
  }
  close(id: string, notify = true) {
    const s = this.sessions.get(id); this.sessions.delete(id);
    if (s) { for (const { socket } of s.sockets.values()) socket.terminate(); for (const r of s.requests.values()) { r.responseAck?.resolve(); r.request.destroy(); } }
    if (notify) this.send(id, { type: 'device_close', accessSessionId: id });
    this.changed();
  }
  stop() { for (const id of [...this.sessions.keys()]) this.close(id, false); this.cookie = ''; }
  private inner(id: string, value: unknown) {
    const s = this.sessions.get(id); if (s) this.send(id, { type: 'sealed', accessSessionId: id, ...s.cipher.seal(value) });
  }
  private handle(id: string, s: Tunnel, m: any) {
    if (!m || typeof m.channel !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(m.channel)) throw new Error('invalid_channel');
    const channel = m.channel;
    if (m.type === 'http_open') {
      if (s.requests.size >= 8 || s.requests.has(channel)) throw new Error('request_limit');
      let path: string;
      try { path = permittedPath(m.method, m.path, s.binding.role); }
      catch { this.inner(id, { type: 'http_error', channel, status: 403, error: 'forbidden_operation' }); return; }
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
                while (this.alive(id) && this.buffered(id) > CHUNK * 2) await new Promise(r => setTimeout(r, 5));
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
      socket.on('open', () => this.inner(id, { type: 'ws_open', channel }));
      let eventClientId: string | undefined;
      let queuedBytes = 0;
      let delivery = Promise.resolve();
      const deliver = (value: Buffer) => {
        // Host frames and local stream errors share one queue, so fragments cannot interleave.
        queuedBytes += value.length;
        if (queuedBytes > 8 * 1024 * 1024) { socket.terminate(); return; }
        socket.pause();
        delivery = delivery.then(async () => {
          for (let offset = 0; offset < value.length; offset += CHUNK) {
            while (this.alive(id) && this.buffered(id) > CHUNK * 2) await new Promise(r => setTimeout(r, 5));
            if (!this.sessions.has(id)) throw new Error('closed');
            this.inner(id, { type: 'ws_data', channel, data: value.subarray(offset, offset + CHUNK).toString('base64'), final: offset + CHUNK >= value.length });
          }
        }).catch(() => socket.close()).finally(() => { queuedBytes -= value.length; if (!queuedBytes && socket.readyState === 1) socket.resume(); });
      };
      s.sockets.set(channel, { socket, deliver });
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
        deliver(value);
      });
      socket.on('error', () => socket.close());
      socket.on('close', () => { s.sockets.delete(channel); this.inner(id, { type: 'ws_close', channel }); }); return;
    }
    if (m.type === 'ws_data') {
      if (typeof m.text !== 'string' || m.text.length > 128 * 1024) throw new Error('frame_limit');
      const target = s.sockets.get(channel);
      if (target?.socket.readyState !== 1 || target.socket.bufferedAmount > MAX_BUFFER) throw new Error('socket_unavailable');
      try { permittedMux(m.text, s.binding.role); }
      catch (error) {
        if (!(error instanceof RemoteStreamDenied)) throw error;
        const frame = { type: 'error', streamId: error.streamId, error: { code: 'forbidden', message: 'This operation is not available through remote access.' } };
        target.deliver(Buffer.from(JSON.stringify(frame)));
        return;
      }
      target.socket.send(m.text); return;
    }
    if (m.type === 'ws_close') { s.sockets.get(channel)?.socket.close(); s.sockets.delete(channel); return; }
    throw new Error('unknown_message');
  }
}
