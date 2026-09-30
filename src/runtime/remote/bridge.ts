import { HostTunnel } from './host-tunnel.ts';
import type { RemoteRuntimeConfig } from '../../shared/remote-access.ts';

const MAX_BUFFER = 4 * 1024 * 1024;

/** One outgoing connection, attached to the app-owned loopback Host; never opens a listener. */
export class RemoteBridge {
  private socket: any;
  private retry?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private attempts = 0;
  private authenticated = false;
  private tunnel: HostTunnel;
  private config: RemoteRuntimeConfig = { enabled: false };
  private WebSocket: any;
  private publish: (state: { status: string; error?: string; connections?: string[] }) => void;
  constructor(WebSocket: any, endpoint: string, launchUrl: string, publish: (state: { status: string; error?: string; connections?: string[] }) => void) {
    this.WebSocket = WebSocket; this.publish = publish;
    this.tunnel = new HostTunnel(WebSocket, endpoint, launchUrl, (_id, frame) => this.send(frame),
      () => this.socket?.readyState === 1, () => this.socket?.bufferedAmount ?? 0, () => this.publishConnections());
  }

  async configure(config: RemoteRuntimeConfig) {
    const previous = this.config.credentials, next = config.credentials;
    if (this.config.enabled && config.enabled && previous && next && previous.deviceId === next.deviceId &&
        previous.deviceToken === next.deviceToken && previous.relay === next.relay) {
      this.config = config; this.tunnel.revokeMissing(next.bindings); this.publishConnections(); return;
    }
    this.stop(); this.config = config;
    if (!config.enabled || !config.credentials) { this.publish({ status: 'disabled' }); return; }
    const generation = this.generation;
    this.publish({ status: 'connecting' });
    await this.tunnel.start();
    if (generation === this.generation) this.connect(generation);
  }
  stop() {
    this.authenticated = false;
    this.generation++; clearTimeout(this.retry); this.retry = undefined;
    this.tunnel.stop();
    this.socket?.terminate(); this.socket = undefined; this.attempts = 0;
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
        if (m.type === 'client_close') { this.tunnel.close(m.accessSessionId, false); return; }
        if (m.type === 'client_hello') {
          const binding = this.config.credentials?.bindings.find(b => b.id === m.bindingId && !b.revoked);
          if (!binding || this.tunnel.size >= 32 || this.tunnel.has(m.accessSessionId)) throw new Error('unapproved_binding');
          this.send(this.tunnel.accept(m.accessSessionId, binding, m)); this.publishConnections(); return;
        }
        if (m.type !== 'sealed') throw new Error('invalid_frame');
        this.tunnel.receive(m.accessSessionId, m);
      } catch { if (typeof JSONSafeSession(raw) === 'string') this.tunnel.close(JSONSafeSession(raw)!); else socket.close(4003, 'invalid_frame'); }
    });
    socket.on('error', () => { if (generation !== this.generation) return; this.publish({ status: 'reconnecting', error: '中继连接失败，请检查地址、网络及证书。' }); });
    socket.on('close', () => {
      clearTimeout(timer); clearInterval(watchdog);
      if (generation !== this.generation) return;
      this.authenticated = false;
      this.tunnel.revokeMissing([]);
      this.publish({ status: 'reconnecting', error: authenticated ? undefined : '中继尚未完成认证。' });
      this.retry = setTimeout(() => this.connect(generation), Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)) + Math.random() * 500);
    });
  }
  private publishConnections() { if (this.authenticated) this.publish({ status: 'online', connections: this.tunnel.bindingIds }); }
  private send(value: unknown) {
    if (!this.socket || this.socket.readyState !== 1) return;
    if (this.socket.bufferedAmount > MAX_BUFFER) { this.socket.terminate(); return; }
    this.socket.send(JSON.stringify(value));
  }
}
function JSONSafeSession(raw: Buffer): string | undefined {
  try { const id = JSON.parse(raw.toString()).accessSessionId; return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : undefined; } catch { return undefined; }
}
