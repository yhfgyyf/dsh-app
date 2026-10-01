/** Public state is deliberately separate from credentials sent only to the owned Host. */
export type RemoteRole = 'viewer' | 'control';
export type RemoteConfig = { enabled: boolean; relay: string; name: string; background: boolean; sessionOnly: boolean };
export type RemoteBinding = { id: string; name: string; account: string; role: RemoteRole; key: string; revoked: boolean; lastSeen?: number };
export type RemoteRelayRoutes = { id: string; endpoints: { origin: string; network: 'private' | 'public' }[] };
export type RemoteCredentials = { relay: string; relayRoutes?: RemoteRelayRoutes; deviceId: string; deviceToken: string; bindings: RemoteBinding[] };
export type LocalRemoteCredentials = { deviceId: string; port?: number; bindings: RemoteBinding[] };
export type RemoteInvitation = { id: string; key: string; expiresAt: number };
export type RemoteRuntimeConfig = { enabled: boolean; credentials?: RemoteCredentials; local?: LocalRemoteCredentials; invitation?: RemoteInvitation };
export type RemoteRuntimeState = {
  status: string; error?: string; connections?: string[];
  lan?: { origins: string[]; port?: number; connections: string[]; error?: string };
};
export type LocalRemoteAction = { type: 'pair'; inviteId: string; name: string } | { type: 'unbind'; bindingId: string };
export type RemoteState = {
  config: RemoteConfig;
  status: 'disabled' | 'connecting' | 'online' | 'reconnecting' | 'error';
  error?: string;
  registered: boolean;
  secureStorage: boolean;
  devices: (Omit<RemoteBinding, 'key'> & { online: boolean })[];
  pending: { id: string; name: string; account: string }[];
  lan?: { origins: string[]; available: boolean };
  pairing?: { qr: string; expiresAt: number };
};
export type RemoteAction =
  | { type: 'configure'; config: RemoteConfig }
  | { type: 'register'; code: string }
  | { type: 'pair' | 'cancel-pair' | 'reconnect' | 'unregister' }
  | { type: 'approve'; id: string; role: RemoteRole }
  | { type: 'revoke'; id: string };

export function defaultRemoteConfig(): RemoteConfig {
  return { enabled: false, relay: '', name: 'DSH Desktop', background: true, sessionOnly: false };
}

/** Credentials may only be sent to a configured HTTPS origin; HTTP is loopback-test only. */
export function relayOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\s]/.test(value)) throw new Error('中继地址无效。');
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('中继必须使用 HTTPS，且不能包含路径或凭据。');
  return url.origin;
}

export function parseRemoteConfig(value: unknown): RemoteConfig {
  const config = value as RemoteConfig;
  if (!config || typeof config.enabled !== 'boolean' || typeof config.background !== 'boolean' || typeof config.sessionOnly !== 'boolean' ||
      typeof config.name !== 'string' || !config.name.trim() || config.name.length > 80) throw new Error('远程设置无效。');
  const relay = config.relay === '' ? '' : relayOrigin(config.relay);
  return { enabled: config.enabled, relay, name: config.name.trim(), background: config.background, sessionOnly: config.sessionOnly };
}

export function parseRemoteCredentials(value: unknown): RemoteCredentials {
  const c = value as RemoteCredentials;
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
  if (!c || !id(c.deviceId) || !id(c.deviceToken) || !Array.isArray(c.bindings) || c.bindings.length > 128) throw new Error('远程凭据无效。');
  const relayRoutes = parseRemoteRelayRoutes(c.relayRoutes);
  return { relay: relayOrigin(c.relay), ...(relayRoutes ? { relayRoutes } : {}), deviceId: c.deviceId, deviceToken: c.deviceToken, bindings: parseRemoteBindings(c.bindings) };
}

export function parseRemoteRelayRoutes(value: unknown): RemoteRelayRoutes | undefined {
  if (value === undefined) return undefined;
  const routes = value as RemoteRelayRoutes;
  if (!routes || typeof routes.id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(routes.id) ||
      !Array.isArray(routes.endpoints) || !routes.endpoints.length || routes.endpoints.length > 6) throw new Error('中继手机入口配置无效。');
  const seen = new Set<string>();
  const endpoints = routes.endpoints.map(entry => {
    if (!entry || !['private', 'public'].includes(entry.network) || typeof entry.origin !== 'string' || entry.origin.length > 256) throw new Error('中继手机入口无效。');
    const origin = relayOrigin(entry.origin);
    if (seen.has(origin)) throw new Error('中继手机入口重复。');
    seen.add(origin);
    return { origin, network: entry.network };
  });
  return { id: routes.id, endpoints };
}

export function phoneRelayOrigin(relay: string, routes?: RemoteRelayRoutes): string {
  return routes?.endpoints.find(e => e.network === 'private')?.origin ?? routes?.endpoints[0]?.origin ?? relay;
}

function parseRemoteBindings(bindings: RemoteBinding[]): RemoteBinding[] {
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
  if (!Array.isArray(bindings) || bindings.length > 128) throw new Error('手机凭据无效。');
  return bindings.map(b => {
    if (!id(b.id) || !/^[A-Za-z0-9_-]{43}$/.test(b.key) || typeof b.name !== 'string' || b.name.length > 80 ||
        typeof b.account !== 'string' || b.account.length > 254 || !['viewer', 'control'].includes(b.role) || typeof b.revoked !== 'boolean') throw new Error('手机凭据无效。');
    return { id: b.id, name: b.name, account: b.account, role: b.role, key: b.key, revoked: b.revoked, ...(typeof b.lastSeen === 'number' && Number.isFinite(b.lastSeen) && b.lastSeen > 0 ? { lastSeen: b.lastSeen } : {}) };
  });
}

export function parseLocalRemoteCredentials(value: unknown): LocalRemoteCredentials {
  const c = value as LocalRemoteCredentials;
  if (!c || typeof c.deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(c.deviceId) ||
      (c.port !== undefined && (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535))) throw new Error('局域网绑定配置无效。');
  return { deviceId: c.deviceId, ...(c.port ? { port: c.port } : {}), bindings: parseRemoteBindings(c.bindings) };
}
