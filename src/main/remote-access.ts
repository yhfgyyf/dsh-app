import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode/lib/server.js';
import { defaultRemoteConfig, parseRemoteConfig, parseRemoteCredentials, type RemoteConfig, type RemoteCredentials, type RemoteState, type RemoteAction, type RemoteRuntimeConfig } from '../shared/remote-access.ts';
import { RemoteCredentialsFile } from './remote-access-credentials.ts';

export class DesktopRemoteAccess {
  private config = defaultRemoteConfig();
  private credentials?: RemoteCredentials;
  private status: RemoteState['status'] = 'disabled';
  private error?: string;
  private restoreError?: string;
  private invitation?: { inviteId: string; key: string; expiresAt: number; qr: string };
  private pending: (RemoteState['pending'][number] & { invite: string })[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private online = new Set<string>();
  private seenDirty = false;
  private syncedRevocations = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private file: RemoteCredentialsFile;
  private configureHost: (config: RemoteRuntimeConfig) => Promise<void>;
  private publish: (state: RemoteState) => void;
  constructor(file: RemoteCredentialsFile, configureHost: (config: RemoteRuntimeConfig) => Promise<void>, publish: (state: RemoteState) => void) {
    this.file = file; this.configureHost = configureHost; this.publish = publish;
  }
  get state(): RemoteState {
    return { config: { ...this.config }, status: this.status, error: this.error ?? this.restoreError, secureStorage: this.file.available(), registered: !!this.credentials,
      devices: this.credentials?.bindings.map(({ key: _key, ...b }) => ({ ...b, online: this.online.has(b.id) })) ?? [], pending: this.pending.map(({ invite: _invite, ...p }) => p),
      pairing: this.invitation ? { qr: this.invitation.qr, expiresAt: this.invitation.expiresAt } : undefined };
  }
  update(value: { status: string; error?: string; connections?: string[] }) {
    if (!['disabled', 'connecting', 'online', 'reconnecting', 'error'].includes(value.status)) return;
    const online = new Set(value.status === 'online' && Array.isArray(value.connections) ? value.connections.filter(id => typeof id === 'string') : []);
    for (const binding of this.credentials?.bindings ?? []) if (online.has(binding.id) || this.online.has(binding.id)) { binding.lastSeen = Date.now(); this.seenDirty = true; }
    this.online = online;
    this.status = value.status as RemoteState['status']; this.error = value.error; this.publish(this.state);
  }
  diagnostics() {
    return { protocol: 'dsh-desktop-remote-v1', status: this.status, enabled: this.config.enabled, relay: this.config.relay,
      registered: !!this.credentials, secureStorage: this.file.available(), sessionOnly: this.config.sessionOnly,
      background: this.config.background, pairedDevices: this.credentials?.bindings.filter(b => !b.revoked).length ?? 0,
      connectedPhones: this.online.size, error: this.error ?? this.restoreError };
  }
  async restore() {
    try { const loaded = await this.file.load(); this.config = loaded.config; this.credentials = loaded.credentials; }
    catch { this.restoreError = '远程配置无法恢复，原文件已保留，请检查系统密钥环。'; this.status = 'error'; }
  }
  async ready() {
    try { await this.apply(); } catch { this.update({ status: 'error', error: '远程模块未就绪，本机会话可继续使用。' }); }
  }
  private async apply() {
    await this.configureHost({ enabled: this.config.enabled, credentials: this.credentials });
    clearInterval(this.timer); this.timer = undefined;
    if (this.config.enabled && this.credentials) {
      this.timer = setInterval(() => { if (this.polling) return; this.polling = true; void this.enqueue(() => this.poll()).catch(() => {}).finally(() => { this.polling = false; }); }, 4000);
      this.timer.unref();
    }
    this.publish(this.state);
  }
  stop() { clearInterval(this.timer); this.timer = undefined; this.invitation = undefined; this.pending = []; }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  private async api(path: string, body: unknown) {
    const response = await fetch(this.config.relay + '/v1/' + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: {
      'content-type': 'application/json', ...(this.credentials ? { authorization: `Bearer ${this.credentials.deviceToken}` } : {}),
    }, body: JSON.stringify({ ...body as object, ...(this.credentials ? { deviceId: this.credentials.deviceId } : {}) }) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 65536) throw new Error('中继响应过大。'); chunks.push(value);
      }
    } finally { await reader?.cancel().catch(() => {}); }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) throw new Error(`中继请求失败（HTTP ${response.status}），请检查注册码、配对有效期或连接状态。`);
    return JSON.parse(text);
  }
  private async poll() {
    if (!this.config.enabled || !this.credentials) return;
    if (this.seenDirty) { this.seenDirty = false; await this.file.save(this.config, this.credentials); }
    const revoked = this.credentials.bindings.find(b => b.revoked && !this.syncedRevocations.has(b.id));
    if (revoked) { await this.api('revoke', { bindingId: revoked.id }); this.syncedRevocations.add(revoked.id); }
    if (!this.invitation) return;
    if (this.invitation.expiresAt <= Date.now()) { this.invitation = undefined; this.pending = []; this.publish(this.state); await this.api('cancel', {}); return; }
    const result = await this.api('pending', {});
    this.pending = (Array.isArray(result.pending) ? result.pending : []).filter((p: any) => p.invite === this.invitation?.inviteId && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.account === 'string').slice(0, 32);
    this.publish(this.state);
  }
  act(action: RemoteAction): Promise<RemoteState> {
    return this.enqueue(async () => {
      if (!action || typeof action.type !== 'string') throw new Error('远程操作无效。');
      if (action.type === 'configure') {
        const config = parseRemoteConfig(action.config);
        if (this.credentials && config.relay !== this.credentials.relay) throw new Error('已注册的中继地址不能直接修改；请使用原中继。');
        await this.file.save(config, this.credentials); this.config = config; this.restoreError = undefined;
        if (!config.enabled) { this.invitation = undefined; this.pending = []; }
        await this.apply();
      } else if (action.type === 'register') {
        if (this.credentials) throw new Error('此电脑已注册。');
        if (!this.config.relay || (!this.config.sessionOnly && !this.file.available())) throw new Error('请先保存中继设置；系统密钥环不可用时选择“仅本次运行”。');
        if (typeof action.code !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(action.code.trim())) throw new Error('注册码无效。');
        const result = await this.api('register', { code: action.code.trim(), name: this.config.name });
        this.credentials = parseRemoteCredentials({ relay: this.config.relay, deviceId: result.deviceId, deviceToken: result.deviceToken, bindings: [] });
        await this.file.save(this.config, this.credentials); await this.apply();
      } else if (action.type === 'pair') {
        if (!this.config.enabled || !this.credentials) throw new Error('请先注册电脑并开启远程控制。');
        const result = await this.api('invite', {}), key = randomBytes(32).toString('base64url');
        const payload = JSON.stringify({ kind: 'dsh-desktop-pair', version: 1, relay: this.config.relay, deviceId: this.credentials.deviceId, name: this.config.name,
          inviteId: result.inviteId, claimSecret: result.claimSecret, expiresAt: result.expiresAt, key });
        this.invitation = { inviteId: result.inviteId, key, expiresAt: result.expiresAt, qr: await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', width: 340 }) }; this.pending = [];
      } else if (action.type === 'cancel-pair') {
        this.invitation = undefined; this.pending = []; this.publish(this.state); await this.api('cancel', {});
      } else if (action.type === 'approve') {
        const pending = this.pending.find(p => p.id === action.id);
        if (!this.credentials || !pending || !this.invitation || this.invitation.expiresAt <= Date.now() || !['viewer', 'control'].includes(action.role)) throw new Error('配对已过期或权限无效。');
        const binding = { id: pending.id, name: pending.name, account: pending.account, role: action.role, key: this.invitation.key, revoked: false };
        const next = { ...this.credentials, bindings: [...this.credentials.bindings.filter(b => b.id !== binding.id), binding] };
        await this.file.save(this.config, next); this.credentials = next;
        try { await this.api('approve', { bindingId: binding.id, role: binding.role }); }
        catch (e) { binding.revoked = true; await this.file.save(this.config, next); await this.apply(); throw e; }
        this.invitation = undefined; this.pending = []; await this.apply();
      } else if (action.type === 'revoke') {
        const binding = this.credentials?.bindings.find(b => b.id === action.id); if (!binding) throw new Error('手机不存在。');
        binding.revoked = true;
        // Close local access before network I/O; persist a tombstone for offline revocation.
        await this.configureHost({ enabled: false });
        await this.file.save(this.config, this.credentials); await this.apply();
        try { await this.api('revoke', { bindingId: binding.id }); } catch { this.error = '桌面已撤销；中继恢复连接后会同步撤销记录。'; }
      } else if (action.type === 'unregister') {
        await this.configureHost({ enabled: false });
        this.stop();
        this.config = { ...this.config, enabled: false };
        await this.file.save(this.config);
        try { await this.api('unregister', {}); } catch { /* Old desktop identity is discarded locally even while offline. */ }
        this.credentials = undefined; this.syncedRevocations.clear();
        this.update({ status: 'disabled' });
      } else if (action.type === 'reconnect') await this.apply();
      else throw new Error('远程操作无效。');
      this.publish(this.state); return this.state;
    });
  }
}
