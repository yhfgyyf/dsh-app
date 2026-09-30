import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { HostTunnel } from './host-tunnel.ts';
import { acceptClientHello, type SecureCipher } from './e2ee.ts';
import type { LocalRemoteAction, RemoteRuntimeConfig, RemoteRuntimeState } from '../../shared/remote-access.ts';

type Network = { address: string; netmask: string };
type Peer = { session: string; bindingId?: string; invitation?: string; cipher?: SecureCipher; busy?: boolean };
const number = (ip: string) => ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
const ipv4 = (ip: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(p => Number(p) <= 255);
export function privateIPv4(ip: string): boolean {
  return ipv4(ip) && (ip.startsWith('10.') || ip.startsWith('192.168.') || (ip.startsWith('172.') && Number(ip.split('.')[1]) >= 16 && Number(ip.split('.')[1]) <= 31));
}
export function lanNetworks(): Network[] {
  return Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
    .filter(n => n.family === 'IPv4' && !n.internal && privateIPv4(n.address)).map(({ address, netmask }) => ({ address, netmask }));
}
export function sameNetwork(peer: string, networks: Network[]): boolean {
  const address = peer.replace(/^::ffff:/, '');
  return ipv4(address) && networks.some(n => (number(address) & number(n.netmask)) === (number(n.address) & number(n.netmask)));
}

/** A phone-specific encrypted listener. The actual Host stays on loopback. */
export class LanRemoteAccess {
  private server?: Server;
  private wss: any;
  private peers = new Map<any, Peer>();
  private routes = new Map<string, any>();
  private tunnel: HostTunnel;
  private config: RemoteRuntimeConfig = { enabled: false };
  private claimed?: string;
  private port?: number;
  private rates = new Map<string, { count: number; until: number }>();
  private WebSocket: any;
  private publish: (state: NonNullable<RemoteRuntimeState['lan']>) => void;
  private action: (action: LocalRemoteAction) => Promise<unknown>;
  private networks: () => Network[];
  constructor(WebSocket: any, endpoint: string, launchUrl: string,
    publish: (state: NonNullable<RemoteRuntimeState['lan']>) => void,
    action: (action: LocalRemoteAction) => Promise<unknown>,
    networks: () => Network[] = lanNetworks) {
    this.WebSocket = WebSocket; this.publish = publish; this.action = action; this.networks = networks;
    this.tunnel = new HostTunnel(WebSocket, endpoint, launchUrl, (id, frame) => this.send(this.routes.get(id), frame),
      id => this.routes.get(id)?.readyState === 1, id => this.routes.get(id)?.bufferedAmount ?? 0,
      () => this.changed(), async bindingId => { await this.action({ type: 'unbind', bindingId }); });
  }
  private changed(error?: string) {
    this.publish({ origins: this.port ? this.networks().map(n => `http://${n.address}:${this.port}`) : [], port: this.port,
      connections: this.tunnel.bindingIds, ...(error ? { error } : {}) });
  }
  async configure(config: RemoteRuntimeConfig) {
    if (config.invitation?.id !== this.config.invitation?.id) this.claimed = undefined;
    this.config = config;
    if (!config.enabled || !config.local || !this.networks().length) { await this.stop(); this.changed(); return; }
    this.tunnel.revokeMissing(config.local.bindings);
    if (this.server) { this.changed(); return; }
    await this.tunnel.start();
    const server = this.server = createServer((_req, res) => { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); });
    server.requestTimeout = 5000; server.headersTimeout = 5000;
    this.wss = new this.WebSocket.WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => {
      const networks = this.networks();
      const host = req.headers.host;
      const ip = req.socket.remoteAddress ?? '';
      const now = Date.now();
      for (const [key, rate] of this.rates) if (rate.until <= now) this.rates.delete(key);
      const rate = this.rates.get(ip) ?? { count: 0, until: now + 60000 };
      rate.count++; this.rates.set(ip, rate);
      if (req.url !== '/v1/lan' || req.headers.origin || !sameNetwork(ip, networks) ||
          !networks.some(n => host === `${n.address}:${this.port}`) || rate.count > 120 || this.peers.size >= 64) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws: any) => this.connected(ws));
    });
    try {
      const listen = (port: number) => new Promise<void>((resolve, reject) => {
        const error = (e: Error) => { server.off('listening', ready); reject(e); };
        const ready = () => { server.off('error', error); resolve(); };
        server.once('error', error); server.once('listening', ready); server.listen(port, '0.0.0.0');
      });
      try { await listen(config.local.port ?? 0); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e; await listen(0); }
      this.port = (server.address() as { port: number }).port;
      this.changed();
    } catch { await this.stop(); this.changed('局域网连接暂不可用。'); }
  }
  private send(ws: any, frame: any) {
    if (!ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.terminate(); return; }
    ws.send(JSON.stringify(frame));
    if (frame.type === 'device_close') ws.close(4003, 'unbound');
  }
  private connected(ws: any) {
    const peer: Peer = { session: randomBytes(32).toString('base64url') };
    this.peers.set(ws, peer); this.routes.set(peer.session, ws);
    let alive = true;
    const deadline = setTimeout(() => ws.close(4001, 'auth_timeout'), 10000);
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 30000);
    ws.on('pong', () => { alive = true; }); ws.on('error', () => {});
    ws.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (peer.busy) throw new Error('pairing_busy');
        if (!peer.bindingId && !peer.invitation) {
          if (m.type !== 'auth' || m.computerId !== this.config.local?.deviceId) throw new Error('auth_required');
          if (typeof m.inviteId === 'string') {
            const invite = this.config.invitation;
            if (!invite || invite.id !== m.inviteId || invite.expiresAt <= Date.now() || this.claimed === invite.id) throw new Error('expired_invitation');
            peer.invitation = invite.id;
          } else {
            const binding = this.config.local?.bindings.find(b => b.id === m.bindingId && !b.revoked);
            if (!binding) throw new Error('unbound');
            peer.bindingId = binding.id;
          }
          this.send(ws, { type: 'auth_ok', accessSessionId: peer.session }); return;
        }
        if (m.accessSessionId !== peer.session) throw new Error('session_mismatch');
        if (m.type === 'client_hello') {
          if (peer.cipher || this.tunnel.has(peer.session)) throw new Error('repeated_handshake');
          if (peer.invitation) {
            const invite = this.config.invitation;
            if (!invite || invite.id !== peer.invitation || invite.expiresAt <= Date.now() || this.claimed === invite.id) throw new Error('expired_invitation');
            const accepted = acceptClientHello(invite.key, m);
            this.claimed = invite.id; peer.cipher = accepted.cipher;
            this.send(ws, { type: 'server_hello', ...accepted.hello });
          } else {
            const binding = this.config.local?.bindings.find(b => b.id === peer.bindingId && !b.revoked);
            if (!binding) throw new Error('unbound');
            this.send(ws, this.tunnel.accept(peer.session, binding, m));
          }
          clearTimeout(deadline); return;
        }
        if (m.type !== 'sealed') throw new Error('invalid_frame');
        if (!peer.invitation) { this.tunnel.receive(peer.session, m); return; }
        const message = peer.cipher!.open(m) as any;
        if (message?.type !== 'pair' || typeof message.name !== 'string' || !message.name.trim() || message.name.length > 80) throw new Error('invalid_pair');
        peer.busy = true;
        void this.action({ type: 'pair', inviteId: peer.invitation, name: message.name.trim() }).then(credential => {
          this.send(ws, { type: 'sealed', accessSessionId: peer.session, ...peer.cipher!.seal({ type: 'paired', credential }) });
          ws.close(1000, 'paired');
        }, () => ws.close(4003, 'pairing_failed'));
      } catch { ws.close(4003, 'invalid_frame_or_credential'); }
    });
    ws.on('close', () => {
      clearTimeout(deadline); clearInterval(heartbeat);
      this.peers.delete(ws); this.routes.delete(peer.session); this.tunnel.close(peer.session, false);
    });
  }
  async stop() {
    this.tunnel.stop();
    for (const ws of this.peers.keys()) ws.terminate();
    this.peers.clear(); this.routes.clear(); this.rates.clear();
    const server = this.server; this.server = undefined; this.port = undefined;
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    this.wss?.close(); this.wss = undefined;
  }
}
