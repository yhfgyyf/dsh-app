import { randomUUID } from 'node:crypto';
import { CollabHost, type HostContext } from './collab-host.ts';
import { CollabClient } from './collab-client.ts';
import { createCollabBroker } from './collab-transport.ts';
import type { DeriveTurnUsage } from './collab-usage.ts';
import { RelayProfileStore, type RelayProfile } from './collab-profile-store.ts';
import { RemoteBridge } from './remote/bridge.ts';
import { LanRemoteAccess } from './remote/lan.ts';
import { DesktopRemoteAccess } from '../main/remote-access.ts';
import { defaultRemoteConfig, parseRemoteConfig, parseRemoteCredentials, parseLocalRemoteCredentials, relayOrigin, type RemoteAction, type RemoteConfig, type RemoteCredentials, type RemoteRuntimeConfig, type RemoteRuntimeState } from '../shared/remote-access.ts';
import { record, textField } from '../../services/relay/src/collab-types.ts';
import type { CollabRpcResult, CollabRun } from '../shared/collab.ts';

type Connection = { WebSocket: any; endpoint: string; launchUrl: string };
type ClientInfo = NonNullable<CollabRun['report']>['client'];
type Active = { profile?: RelayProfile; client: CollabClient; host: CollabHost; remote?: ProfileRemote };

/** Own both phone transports so a profile can be completely disconnected without server revocation. */
class ProfileRemote {
  readonly remote: DesktopRemoteAccess;
  private bridge: RemoteBridge;
  private lan: LanRemoteAccess;
  private runtimeState: RemoteRuntimeState = { status: 'disabled' };
  private closed = false;
  private file: Awaited<ReturnType<RelayProfileStore['credentials']>>;
  credentials?: RemoteCredentials;
  constructor(file: Awaited<ReturnType<RelayProfileStore['credentials']>>, connection: Connection) {
    this.file = file;
    const update = (state: RemoteRuntimeState) => { if (this.closed) return; this.runtimeState = { ...this.runtimeState, ...state }; this.remote.update(this.runtimeState); };
    this.bridge = new RemoteBridge(connection.WebSocket, connection.endpoint, connection.launchUrl, update);
    this.lan = new LanRemoteAccess(connection.WebSocket, connection.endpoint, connection.launchUrl, lan => update({ ...this.runtimeState, lan }), action => this.remote.localAction(action));
    this.remote = new DesktopRemoteAccess(file, async config => {
      if (this.closed) throw new Error('此中继连接已关闭。');
      this.credentials = config.credentials;
      await this.lan.configure(config); await this.bridge.configure(config);
    }, () => {});
  }
  async start() { await this.remote.restore(); if (this.remote.state.error) throw new Error(this.remote.state.error); await this.remote.ready(); }
  async stop() {
    if (this.closed) return;
    const enabled = this.remote.state.config.enabled;
    try {
      // Drains queued pairing/poll operations, persists their latest state, and closes active connections.
      await this.remote.act({ type: 'configure', config: { ...this.remote.state.config, enabled: false } });
      const saved = await this.file.load();
      await this.file.save({ ...saved.config, enabled }, saved.credentials, saved.local);
    } finally { this.closed = true; this.remote.stop(); this.bridge.stop(); await this.lan.stop(); }
  }
}

export class CollabRelayManager {
  readonly store: RelayProfileStore;
  private active?: Active;
  private queue: Promise<unknown> = Promise.resolve();
  private captured?: RemoteRuntimeConfig;
  private connection?: Connection;
  private closed = false;
  private nativeEnabled = false;
  private ctx: HostContext;
  private derive: DeriveTurnUsage;
  private info: ClientInfo;
  constructor(home: string, ctx: HostContext, derive: DeriveTurnUsage, info: ClientInfo) { this.store = new RelayProfileStore(home); this.ctx = ctx; this.derive = derive; this.info = info; }
  capture = (message: any) => {
    if (message?.type !== 'remote-configure' || !message.config || typeof message.config.enabled !== 'boolean') return;
    // Existing desktop-to-owned-runtime IPC only. This snapshot is never returned by any RPC.
    this.captured = structuredClone(message.config); this.nativeEnabled = message.config.enabled;
  };
  private exclusive<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  async start(connection: Connection) {
    this.connection = connection; await this.store.restore();
    this.active = await this.load(this.store.data.activeId ? this.store.get(this.store.data.activeId) : undefined);
    this.active.host.start();
  }
  private async load(profile?: RelayProfile): Promise<Active> {
    let remote: ProfileRemote | undefined;
    try {
      if (profile) {
        const file = await this.store.credentials(profile.id), saved = await file.load();
        if (saved.config.relay !== profile.relay) throw new Error('中继配置地址与保存的凭据不一致，原文件已保留。');
        remote = new ProfileRemote(file, this.connection!); await remote.start();
      }
      const broker = remote ? createCollabBroker(() => remote!.credentials) : this.ctx.desktopCollabBroker;
      const client = new CollabClient(profile ? this.store.collaborationHome(profile) : this.store.home, broker); await client.restore();
      if (profile && client.data.origin && client.data.origin !== profile.relay) throw new Error('协作身份属于其他中继，原文件已保留。');
      return { profile, client, host: new CollabHost(client, this.ctx, this.derive, this.info), remote };
    } catch (error) { await remote?.stop().catch(() => {}); throw error; }
  }
  private required() { if (!this.active || this.closed) throw new Error('中继配置尚未就绪。'); return this.active; }
  private async switchTo(id: string) {
    const profile = this.store.get(id), previous = this.required();
    if (previous.profile?.id === id) return;
    if (this.nativeEnabled) throw new Error('请先断开原 DSH 手机连接，再切换中继配置。');
    let next: Active | undefined, suspended = false;
    try {
      await previous.host.suspend(); suspended = true; await previous.remote?.stop();
      next = await this.load(profile);
      await this.store.save({ ...this.store.data, activeId: id });
      this.active = next; next.host.start();
    } catch (error) {
      await next?.host.stop().catch(() => {}); await next?.remote?.stop().catch(() => {});
      this.active = suspended ? await this.load(previous.profile) : previous; this.active.host.start();
      throw error;
    }
  }
  private async state() {
    const current = this.required();
    const profiles = await Promise.all(this.store.data.profiles.filter(p => !p.archivedAt).map(async profile => {
      try {
        const saved = await (await this.store.credentials(profile.id)).load();
        const bindings = new Map([...saved.credentials?.bindings ?? [], ...saved.local?.bindings ?? []].map(binding => [binding.id, binding]));
        return { ...profile, registered: !!saved.credentials, pairedDevices: [...bindings.values()].filter(binding => !binding.revoked).length };
      } catch { return { ...profile, registered: false, pairedDevices: 0, error: '此配置无法读取，原文件已保留。' }; }
    }));
    return { activeId: current.profile?.id ?? '', profiles, needsImport: !current.profile, nativeEnabled: this.nativeEnabled,
      remote: current.remote?.remote.state ?? null, credentialStorage: process.platform === 'win32' ? 'AES-256-GCM / Windows DPAPI' : 'AES-256-GCM / 当前用户私有密钥' };
  }
  private async adopt(config: RemoteConfig) {
    if (this.required().profile) return;
    if (this.store.data.profiles.length) {
      const profile = this.store.data.profiles[0];
      await this.preserveLegacyIdentity(profile); await this.switchTo(profile.id); return;
    }
    const captured = this.captured;
    if (!captured || captured.enabled) throw new Error('请先通过原 DSH 设置断开手机连接，再迁移中继配置。');
    const parsed = parseRemoteConfig(config), credentials = captured.credentials ? parseRemoteCredentials(captured.credentials) : undefined;
    const local = captured.local ? parseLocalRemoteCredentials(captured.local) : undefined;
    if (credentials && credentials.relay !== parsed.relay) throw new Error('原中继地址与设备凭据不一致。');
    const profile: RelayProfile = { id: randomUUID(), name: parsed.relay ? new URL(parsed.relay).host : '默认中继', relay: parsed.relay, createdAt: Date.now(), legacy: true };
    const file = await this.store.credentials(profile.id);
    await file.save({ ...parsed, sessionOnly: false }, credentials, local);
    await this.store.save({ ...this.store.data, profiles: [profile] });
    // The original collaboration directory remains in place, including checkpoints and session workspaces.
    await this.preserveLegacyIdentity(profile);
    await this.switchTo(profile.id);
  }
  private async preserveLegacyIdentity(profile: RelayProfile) {
    const origin = this.required().client.data.origin;
    if (!profile.legacy || !origin || origin === profile.relay) return;
    // A user could switch native registration before installing multi-relay support.
    // Keep the old identity at its original path; never attach it to the new registration.
    const relay = relayOrigin(origin), previous: RelayProfile = {
      id: randomUUID(), name: new URL(relay).host.slice(0, 80), relay, createdAt: Date.now(), legacy: true,
    };
    await (await this.store.credentials(previous.id)).save({ ...defaultRemoteConfig(), relay, name: previous.name });
    const current = { ...profile }; delete current.legacy;
    await this.store.save({ ...this.store.data, profiles: this.store.data.profiles.map(p => p.id === profile.id ? current : p).concat(previous) });
  }
  handle(endpoint: string, payload: unknown, signal: AbortSignal): Promise<CollabRpcResult> {
    const profileAtReceipt = this.active?.profile?.id ?? '';
    return this.exclusive(async () => {
      try {
        signal.throwIfAborted();
        const b = record(record(payload).args ?? {}), current = this.required();
        if (endpoint.startsWith('relays/')) {
          const method = endpoint.slice(7);
          if (method === 'state') return { ok: true, value: await this.state() };
          if (method === 'adopt') await this.adopt(b.config as RemoteConfig);
          else if (method === 'create') {
            if (!current.profile) throw new Error('请先保存当前中继配置。');
            await this.store.create(textField(b.name, 80), textField(b.relay, 2048));
          } else if (method === 'switch') await this.switchTo(textField(b.id, 36));
          else if (method === 'rename') {
            const profile = this.store.get(textField(b.id, 36)), name = this.store.name(b.name);
            await this.store.save({ ...this.store.data, profiles: this.store.data.profiles.map(p => p.id === profile.id ? { ...p, name } : p) });
            if (current.profile?.id === profile.id) current.profile = this.store.get(profile.id);
          } else if (method === 'archive') {
            const profile = this.store.get(textField(b.id, 36));
            if (profile.id === current.profile?.id) throw new Error('请先切换到其他中继，再移除此配置。');
            await this.store.save({ ...this.store.data, profiles: this.store.data.profiles.map(p => p.id === profile.id ? { ...p, archivedAt: Date.now() } : p) });
          } else if (method === 'remote') {
            if (!current.remote || !current.profile || b.profileId !== current.profile.id) throw new Error('中继已切换，请刷新后重试。');
            const action = record(b.action) as RemoteAction;
            if (action.type === 'configure') {
              const config = parseRemoteConfig(action.config);
              if (config.relay !== current.profile.relay) {
                if (current.remote.remote.state.registered || current.client.data.origin) throw new Error('此配置已有注册或协作记录；请为其他地址新增中继配置。');
                const relay = relayOrigin(config.relay);
                const previousConfig = current.remote.remote.state.config;
                await current.remote.remote.act({ type: 'configure', config: { ...config, relay, sessionOnly: false } });
                try { await this.store.save({ ...this.store.data, profiles: this.store.data.profiles.map(p => p.id === current.profile!.id ? { ...p, relay } : p) }); }
                catch (error) { await current.remote.remote.act({ type: 'configure', config: previousConfig }); throw error; }
                current.profile = this.store.get(current.profile.id);
              } else await current.remote.remote.act({ ...action, config: { ...config, sessionOnly: false } });
            } else if (action.type === 'unregister') {
              if (b.confirm !== true) throw new Error('解除注册会撤销服务器上的设备注册，请明确确认。');
              await current.host.suspend('已解除此中继注册；本机草稿和进度已保存。');
              try { await current.remote.remote.act(action); } finally { current.host.start(); }
            } else await current.remote.remote.act(action);
          } else throw new Error('不支持此中继配置操作。');
          return { ok: true, value: await this.state() };
        }
        if (profileAtReceipt !== (current.profile?.id ?? '') || (b.$relayProfileId !== undefined && b.$relayProfileId !== (current.profile?.id ?? ''))) throw new Error('中继已切换；此操作属于原配置，请切回后重试。');
        const args = { ...b }; delete args.$relayProfileId;
        if (endpoint === 'state') return { ok: true, value: { ...current.client.state(), relayProfileId: current.profile?.id ?? '', relayProfileName: current.profile?.name } };
        const result = await current.host.handle(endpoint, { args }, signal);
        if (result.ok && endpoint === 'profile') result.value = { ...result.value, relayProfileId: current.profile?.id ?? '', relayProfileName: current.profile?.name };
        return result;
      } catch (error) { return { ok: false, error: { code: 'collab/relay-profile', message: error instanceof Error ? error.message : '中继配置操作失败。', details: {} } }; }
    });
  }
  async stop() {
    this.closed = true;
    await this.queue;
    try { await this.active?.host.suspend('插件已关闭；探索进度已保存。'); }
    finally { await this.active?.remote?.stop(); }
  }
}
