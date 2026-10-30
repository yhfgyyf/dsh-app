import { hostname } from 'node:os';
import { join } from 'node:path';
import { CollabHost, PLUGIN_VERSION } from '../../../src/runtime/collab-host.ts';
import { CollabClient } from '../../../src/runtime/collab-client.ts';
import { createCollabBroker } from '../../../src/runtime/collab-transport.ts';
import { DesktopRemoteAccess } from '../../../src/main/remote-access.ts';
import { RemoteBridge } from '../../../src/runtime/remote/bridge.ts';
import type { RemoteCredentials, RemoteAction } from '../../../src/shared/remote-access.ts';
import { CodexRuntime, deriveCodexUsage, type RuntimeOptions } from './codex-runtime.ts';
import { credentialFile } from './vault.ts';
import { MobileHost } from './mobile-host.ts';
import { WebSocket } from './websocket.ts';

export const COLLAB_METHODS = ['state', 'identity', 'sync', 'catalog', 'detail', 'candidates', 'history', 'inbox', 'read', 'create', 'update', 'follow', 'accept', 'validate', 'complete', 'upload', 'download', 'profile', 'draft-get', 'draft-put', 'start', 'run', 'cancel', 'attempt-pause', 'attempt-resume', 'attempt-configure', 'attempt-withdraw', 'reply', 'generated-file', 'publish-run'] as const;
export class CollaborationService {
  readonly home: string;
  readonly runtime: CodexRuntime;
  readonly mobile: MobileHost;
  readonly client: CollabClient;
  readonly host: CollabHost;
  private remote!: DesktopRemoteAccess;
  private bridge?: RemoteBridge;
  private credentials?: RemoteCredentials;
  private closing = false;
  constructor(home: string, options: RuntimeOptions = {}) {
    this.home = home; this.runtime = new CodexRuntime(home, options);
    const broker = createCollabBroker(() => this.credentials);
    this.client = new CollabClient(home, broker);
    this.host = new CollabHost(this.client, { connection: { rpc: { handle: () => () => {} } },
      sessionController: { create: this.runtime.create, rename: this.runtime.rename, inspect: this.runtime.inspect, cancel: this.runtime.cancel,
        prompt: (value, signal) => this.runtime.prompt({ ...value, cwd: join(home, 'collaboration', 'workspaces', value.requestId) }, signal) },
      sessionPersistence: { flush: () => this.runtime.flush(), list: this.runtime.list }, agents: this.runtime,
      desktopCollabBroker: broker, effect: () => {} }, deriveCodexUsage,
    { appVersion: 'Codex collaboration 0.1.0', runtimeVersion: 'codex app-server', pluginVersion: PLUGIN_VERSION, platform: process.platform, arch: process.arch, harness: 'codex', usageUnit: 'turn' });
    this.mobile = new MobileHost(this.runtime, this.call);
  }
  async start() {
    await this.runtime.restore(); await this.client.restore(); await this.mobile.start();
    this.bridge = new RemoteBridge(WebSocket, this.mobile.endpoint, this.mobile.launchUrl, state => this.remote?.update(state));
    this.remote = new DesktopRemoteAccess(await credentialFile(this.home), async config => {
      this.credentials = config.credentials; await this.bridge!.configure(config);
    }, () => {});
    await this.remote.restore();
    if (this.remote.state.error) throw new Error(this.remote.state.error);
    await this.remote.ready(); this.host.start();
  }
  call = async (method: string, args: any = {}, signal: AbortSignal = new AbortController().signal): Promise<any> => {
    if (this.closing) throw new Error('The collaboration service is stopping.');
    if (typeof method !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid operation.');
    if (method === 'status') return { version: '0.1.0', harness: 'codex', home: this.home, remote: this.remote?.diagnostics(), collaboration: this.client.state(),
      runningSessions: [...this.runtime.sessions.values()].filter(s => s.status === 'running').map(s => s.id), pendingInputs: this.runtime.pending.size, credentialStorage: 'private-profile-files', native: this.runtime.app.info ?? null, defaultModel: this.runtime.defaultModel };
    if (method.startsWith('collab/')) {
      const endpoint = method.slice(7); if (!(COLLAB_METHODS as readonly string[]).includes(endpoint)) throw new Error('Unknown collaboration operation.');
      const result = await this.host.handle(endpoint, { args: endpoint === 'profile' ? { ...this.client.data.settings, ...args } : args }, signal);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.value;
    }
    if (method === 'remote/state') return this.remote.state;
    if (method === 'remote/register') {
      if (this.remote.state.registered) throw new Error('This profile is already registered.');
      await this.remote.act({ type: 'configure', config: { ...this.remote.state.config, enabled: false, relay: args.relay, name: args.name ?? `Codex · ${hostname()}`.slice(0, 80), sessionOnly: false } });
      const state = await this.remote.act({ type: 'register', code: args.code });
      await this.client.sync(); return state;
    }
    if (method.startsWith('remote/')) {
      const type = method.slice(7);
      if (!['pair', 'cancel-pair', 'reconnect', 'revoke', 'unregister', 'approve', 'configure'].includes(type)) throw new Error('Unknown remote operation.');
      return this.remote.act({ ...args, type } as RemoteAction);
    }
    if (method === 'codex/sessions') return [...this.runtime.sessions.values()].map(s => ({ ...this.mobile.summary(s), threadId: s.threadId }));
    if (method === 'codex/create') return this.runtime.create(args);
    if (method === 'codex/models') return this.runtime.models();
    if (method === 'codex/configure-model') return this.runtime.configureModel(args.model);
    if (method === 'codex/select-model') return this.runtime.selectModel(args);
    if (method === 'codex/prompt') return this.runtime.prompt(args, signal);
    if (method === 'codex/cancel') return this.runtime.cancel(args);
    if (method === 'codex/rename') return this.runtime.rename(args);
    if (method === 'codex/inspect') return this.runtime.inspect(args.sessionId);
    if (method === 'codex/inputs') return [...this.runtime.pending.values()].map(({ nativeId: _, generation: __, ...r }) => r);
    if (method === 'codex/answer') return this.runtime.answer(args.id, args.result);
    throw new Error('Unknown operation.');
  };
  async stop() {
    this.closing = true; this.remote?.stop(); this.bridge?.stop();
    try { await this.host.stop(); } finally { try { await this.runtime.stop(); } finally { await this.mobile.stop(); } }
  }
}
