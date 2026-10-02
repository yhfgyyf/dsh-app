import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import QRCode from 'qrcode/lib/server.js';
import { defaultRemoteConfig, parseRemoteConfig, parseRemoteCredentials, parseRemoteRelayRoutes, phoneRelayOrigin, type RemoteRelayRoutes, type LocalRemoteAction, type LocalRemoteCredentials, type RemoteBinding, type RemoteCredentials, type RemoteState, type RemoteAction, type RemoteRuntimeConfig, type RemoteRuntimeState } from '../shared/remote-access.ts';
import { RemoteCredentialsFile } from './remote-access-credentials.ts';
import { fetchWithRelayCa, parseRegistrationCode, relayConnectionError, retrieveRelayCa } from './relay-ca.ts';

export class DesktopRemoteAccess {
  private config = { ...defaultRemoteConfig(), name: hostname().slice(0, 80) || 'DSH Desktop' };
  private credentials?: RemoteCredentials;
  private local: LocalRemoteCredentials = { deviceId: randomBytes(24).toString('base64url'), bindings: [] };
  private lan: NonNullable<RemoteRuntimeState['lan']> = { origins: [], connections: [] };
  private status: RemoteState['status'] = 'disabled';
  private error?: string;
  private restoreError?: string;
  private invitation?: { id: string; inviteId?: string; key: string; expiresAt: number; qr: string; relay?: { origin: string; routes?: RemoteRelayRoutes } };
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
    const bindings = new Map([...this.credentials?.bindings ?? [], ...this.local.bindings].map(b => [b.id, b]));
    return { config: { ...this.config }, status: this.status, error: this.error ?? this.restoreError, secureStorage: this.file.available(), registered: !!this.credentials,
      devices: [...bindings.values()].map(({ key: _key, ...b }) => ({ ...b, online: this.online.has(b.id) || this.lan.connections.includes(b.id) })), pending: this.pending.map(({ invite: _invite, ...p }) => p),
      lan: { origins: [...this.lan.origins], available: this.lan.origins.length > 0 },
      pairing: this.invitation ? { qr: this.invitation.qr, expiresAt: this.invitation.expiresAt } : undefined };
  }
  update(value: RemoteRuntimeState) {
    if (!['disabled', 'connecting', 'online', 'reconnecting', 'error'].includes(value.status)) return;
    const online = new Set(value.status === 'online' && Array.isArray(value.connections) ? value.connections.filter(id => typeof id === 'string') : []);
    if (value.lan) {
      this.lan = value.lan;
      if (value.lan.port && this.local.port !== value.lan.port) { this.local.port = value.lan.port; this.seenDirty = true; }
    }
    for (const binding of [...this.credentials?.bindings ?? [], ...this.local.bindings]) if (online.has(binding.id) || this.online.has(binding.id) || this.lan.connections.includes(binding.id)) { binding.lastSeen = Date.now(); this.seenDirty = true; }
    this.online = online;
    this.status = value.status as RemoteState['status']; this.error = value.error; this.publish(this.state);
  }
  diagnostics() {
    return { protocol: 'dsh-desktop-remote-v1', status: this.status, enabled: this.config.enabled, relay: this.config.relay,
      registered: !!this.credentials, secureStorage: this.file.available(), sessionOnly: this.config.sessionOnly,
      background: this.config.background, pairedDevices: this.state.devices.filter(b => !b.revoked).length,
      connectedPhones: new Set([...this.online, ...this.lan.connections]).size, error: this.error ?? this.restoreError };
  }
  async restore() {
    try {
      const loaded = await this.file.load();
      this.config = { ...loaded.config, background: true, name: loaded.config.name === 'DSH Desktop' ? this.config.name : loaded.config.name };
      this.credentials = loaded.credentials; if (loaded.local) this.local = loaded.local;
    }
    catch { this.restoreError = '远程配置无法恢复，原文件已保留，请检查系统密钥环。'; this.status = 'error'; }
  }
  async ready() {
    try { await this.apply(); } catch { this.update({ status: 'error', error: '远程模块未就绪，本机会话可继续使用。' }); }
  }
  private async apply() {
    await this.configureHost({ enabled: this.config.enabled, credentials: this.credentials, local: this.local,
      invitation: this.invitation ? { id: this.invitation.id, key: this.invitation.key, expiresAt: this.invitation.expiresAt } : undefined });
    clearInterval(this.timer); this.timer = undefined;
    if (this.config.enabled) {
      this.timer = setInterval(() => { if (this.polling) return; this.polling = true; void this.enqueue(() => this.poll()).catch(() => {}).finally(() => { this.polling = false; }); }, 2000);
      this.timer.unref();
    }
    this.publish(this.state);
  }
  stop() { clearInterval(this.timer); this.timer = undefined; this.invitation = undefined; this.pending = []; }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  private save() { return this.file.save(this.config, this.credentials, this.config.enabled || this.local.bindings.length ? this.local : undefined); }
  private async api(path: string, body: unknown, ca = this.credentials?.relayCa) {
    const headers = {
      'content-type': 'application/json', ...(this.credentials ? { authorization: `Bearer ${this.credentials.deviceToken}` } : {}),
    };
    const payload = JSON.stringify({ ...body as object, ...(this.credentials ? { deviceId: this.credentials.deviceId } : {}) });
    const url = this.config.relay + '/v1/' + path;
    const response = await (ca ? fetchWithRelayCa(url, headers, payload, ca) : fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers, body: payload,
    })).catch(error => { throw relayConnectionError(error); });
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
    if (!this.config.enabled) return;
    if (this.seenDirty) { this.seenDirty = false; await this.save(); }
    if (this.invitation && this.invitation.expiresAt <= Date.now()) {
      this.invitation = undefined; this.pending = []; await this.apply();
      if (this.credentials) await this.api('cancel', {}).catch(() => {});
    }
    if (!this.credentials) return;
    const revoked = this.credentials.bindings.find(b => b.revoked && !this.syncedRevocations.has(b.id));
    if (revoked) { await this.api('revoke', { bindingId: revoked.id }); this.syncedRevocations.add(revoked.id); }
    // Older deployed relays have no state-sync endpoint; preserve their existing bindings.
    const states = await this.api('bindings', {}).catch(() => undefined);
    let changed = false;
    if (Array.isArray(states?.bindings)) for (const state of states.bindings) if (state.state === 'revoked') {
      for (const binding of [...this.credentials.bindings, ...this.local.bindings]) if (binding.id === state.id && !binding.revoked) { binding.revoked = true; changed = true; }
    }
    if (changed) { await this.save(); await this.apply(); }
    if (!this.invitation?.inviteId) return;
    const result = await this.api('pending', {});
    this.pending = (Array.isArray(result.pending) ? result.pending : []).filter((p: any) => p.invite === this.invitation?.inviteId && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.account === 'string').slice(0, 32);
    if (this.pending[0]) await this.approve(this.pending[0].id, 'control');
    this.publish(this.state);
  }
  private async approve(id: string, role: 'viewer' | 'control') {
    const pending = this.pending.find(p => p.id === id);
    if (!this.credentials || !pending || !this.invitation || this.invitation.expiresAt <= Date.now()) throw new Error('配对已过期。');
    const binding: RemoteBinding = { id, name: pending.name, account: pending.account, role, key: this.invitation.key, revoked: false };
    this.credentials.bindings = [...this.credentials.bindings.filter(b => b.id !== id), binding];
    this.local.bindings = [...this.local.bindings.filter(b => b.id !== id), { ...binding }];
    await this.save();
    try { await this.api('approve', { bindingId: id, role }); }
    catch (e) { binding.revoked = true; this.local.bindings.find(b => b.id === id)!.revoked = true; await this.save(); await this.apply(); throw e; }
    this.invitation = undefined; this.pending = []; await this.apply();
  }
  private async revoke(id: string) {
    const bindings = [...this.local.bindings, ...this.credentials?.bindings ?? []].filter(b => b.id === id);
    if (!bindings.length) throw new Error('手机不存在。');
    for (const binding of bindings) binding.revoked = true;
    await this.save(); await this.apply();
    if (this.credentials?.bindings.some(b => b.id === id)) {
      try { await this.api('revoke', { bindingId: id }); this.syncedRevocations.add(id); }
      catch { this.error = '此电脑已解绑；中继恢复连接后会同步。'; }
    }
  }
  localAction(action: LocalRemoteAction): Promise<unknown> {
    return this.enqueue(async () => {
      if (action.type === 'unbind') { await this.revoke(action.bindingId); return { ok: true }; }
      const invite = this.invitation;
      if (!this.config.enabled || !invite || invite.id !== action.inviteId || invite.expiresAt <= Date.now() ||
          typeof action.name !== 'string' || !action.name.trim() || action.name.length > 80) throw new Error('配对已失效。');
      if (this.local.bindings.filter(b => !b.revoked).length >= 32) throw new Error('手机绑定数量已达上限。');
      this.invitation = undefined; this.pending = [];
      const response = this.credentials && invite.relay ? await this.api('bind', { name: action.name }).catch(() => undefined) : undefined;
      const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
      const relay = response && validId(response.bindingId) && validId(response.bindingToken) ? response : undefined;
      const binding: RemoteBinding = { id: relay?.bindingId ?? randomBytes(32).toString('base64url'), name: action.name,
        account: '此电脑', role: 'control', key: invite.key, revoked: false };
      this.local.bindings.push(binding);
      if (relay && this.credentials) this.credentials.bindings.push({ ...binding });
      try { await this.save(); await this.apply(); }
      catch (error) {
        binding.revoked = true;
        const central = this.credentials?.bindings.find(b => b.id === binding.id); if (central) central.revoked = true;
        await this.save().catch(() => {}); await this.apply();
        if (relay) await this.api('revoke', { bindingId: binding.id }).catch(() => {});
        throw error;
      }
      if (this.credentials) await this.api('cancel', {}).catch(() => {});
      return { bindingId: binding.id, bindingToken: relay?.bindingToken ?? '', key: binding.key, computerId: this.local.deviceId,
        lanOrigins: [...this.lan.origins], ...(relay ? { relay: invite.relay!.origin,
          ...(invite.relay!.routes ? { relayRoutes: invite.relay!.routes } : {}) } : {}) };
    });
  }
  act(action: RemoteAction): Promise<RemoteState> {
    return this.enqueue(async () => {
      if (!action || typeof action.type !== 'string') throw new Error('远程操作无效。');
      if (action.type === 'configure') {
        const config = parseRemoteConfig(action.config);
        if (this.credentials && config.relay !== this.credentials.relay) throw new Error('已注册的中继地址不能直接修改；请使用原中继。');
        config.background = true;
        if (!this.file.available()) config.sessionOnly = true;
        await this.file.save(config, this.credentials, this.local); this.config = config; this.restoreError = undefined;
        if (!config.enabled) { this.invitation = undefined; this.pending = []; }
        await this.apply();
      } else if (action.type === 'register') {
        if (this.credentials) throw new Error('此电脑已注册。');
        if (!this.config.relay) throw new Error('请先填写中继地址。');
        if (!this.file.available()) this.config.sessionOnly = true;
        const registration = parseRegistrationCode(action.code);
        const relayCa = registration.fingerprint ? await retrieveRelayCa(this.config.relay, registration.fingerprint) : undefined;
        const result = await this.api('register', { code: registration.code, name: this.config.name }, relayCa);
        this.credentials = parseRemoteCredentials({ relay: this.config.relay, relayRoutes: result.relayRoutes, relayCa, deviceId: result.deviceId, deviceToken: result.deviceToken, bindings: [] });
        this.config.enabled = true;
        await this.save(); await this.apply();
      } else if (action.type === 'pair') {
        this.config.enabled = true; this.config.background = true;
        if (!this.file.available()) this.config.sessionOnly = true;
        await this.save(); await this.apply();
        const result = this.credentials ? await this.api('invite', { qr: true }).catch(() => undefined) : undefined;
        if (!this.lan.origins.length && !result) throw new Error('请连接局域网，或先注册可用的中继。');
        let relay: { origin: string; routes?: RemoteRelayRoutes } | undefined;
        if (result) {
          const routes = parseRemoteRelayRoutes(result.relayRoutes);
          this.credentials!.relayRoutes = routes;
          await this.save();
          relay = { origin: phoneRelayOrigin(this.config.relay, routes), ...(routes ? { routes } : {}) };
        }
        const id = randomBytes(24).toString('base64url'), key = randomBytes(32).toString('base64url');
        const expiresAt = Math.min(Date.now() + 120000, result?.expiresAt ?? Infinity);
        const payload = JSON.stringify({ kind: 'dsh-desktop-pair', version: 2, computerId: this.local.deviceId, name: this.config.name, key, expiresAt,
          lan: { origins: this.lan.origins, inviteId: id }, ...(result ? { relay: { ...relay, deviceId: this.credentials!.deviceId,
            inviteId: result.inviteId, claimSecret: result.claimSecret } } : {}) });
        this.invitation = { id, inviteId: result?.inviteId, key, expiresAt, relay, qr: await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', width: 340 }) }; this.pending = [];
        await this.apply();
      } else if (action.type === 'cancel-pair') {
        this.invitation = undefined; this.pending = []; await this.apply(); if (this.credentials) await this.api('cancel', {});
      } else if (action.type === 'approve') {
        if (!['viewer', 'control'].includes(action.role)) throw new Error('权限无效。');
        await this.approve(action.id, action.role);
      } else if (action.type === 'revoke') {
        await this.revoke(action.id);
      } else if (action.type === 'unregister') {
        // LAN pairing and transport failures retain registration; only this explicit action removes it.
        if (this.credentials) await this.api('unregister', {});
        this.credentials = undefined; this.syncedRevocations.clear();
        this.invitation = undefined; this.pending = [];
        await this.save(); await this.apply();
      } else if (action.type === 'reconnect') await this.apply();
      else throw new Error('远程操作无效。');
      this.publish(this.state); return this.state;
    });
  }
}
