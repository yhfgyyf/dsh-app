/** Public state is deliberately separate from credentials sent only to the owned Host. */
export type RemoteRole = 'viewer' | 'control';
export type RemoteConfig = { enabled: boolean; relay: string; name: string; background: boolean; sessionOnly: boolean };
export type RemoteBinding = { id: string; name: string; account: string; role: RemoteRole; key: string; revoked: boolean; lastSeen?: number };
export type RemoteCredentials = { relay: string; deviceId: string; deviceToken: string; bindings: RemoteBinding[] };
export type RemoteRuntimeConfig = { enabled: boolean; credentials?: RemoteCredentials };
export type RemoteState = {
  config: RemoteConfig;
  status: 'disabled' | 'connecting' | 'online' | 'reconnecting' | 'error';
  error?: string;
  registered: boolean;
  secureStorage: boolean;
  devices: (Omit<RemoteBinding, 'key'> & { online: boolean })[];
  pending: { id: string; name: string; account: string }[];
  pairing?: { qr: string; expiresAt: number };
};
export type RemoteAction =
  | { type: 'configure'; config: RemoteConfig }
  | { type: 'register'; code: string }
  | { type: 'pair' | 'cancel-pair' | 'reconnect' | 'unregister' }
  | { type: 'approve'; id: string; role: RemoteRole }
  | { type: 'revoke'; id: string };

export function defaultRemoteConfig(): RemoteConfig {
  return { enabled: false, relay: '', name: 'DSH Desktop', background: false, sessionOnly: false };
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
  const relay = config.relay === '' && !config.enabled ? '' : relayOrigin(config.relay);
  return { enabled: config.enabled, relay, name: config.name.trim(), background: config.background, sessionOnly: config.sessionOnly };
}

export function parseRemoteCredentials(value: unknown): RemoteCredentials {
  const c = value as RemoteCredentials;
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
  if (!c || !id(c.deviceId) || !id(c.deviceToken) || !Array.isArray(c.bindings) || c.bindings.length > 128) throw new Error('远程凭据无效。');
  const bindings = c.bindings.map(b => {
    if (!id(b.id) || !/^[A-Za-z0-9_-]{43}$/.test(b.key) || typeof b.name !== 'string' || b.name.length > 80 ||
        typeof b.account !== 'string' || b.account.length > 254 || !['viewer', 'control'].includes(b.role) || typeof b.revoked !== 'boolean') throw new Error('手机凭据无效。');
    return { id: b.id, name: b.name, account: b.account, role: b.role, key: b.key, revoked: b.revoked, ...(typeof b.lastSeen === 'number' && Number.isFinite(b.lastSeen) && b.lastSeen > 0 ? { lastSeen: b.lastSeen } : {}) };
  });
  return { relay: relayOrigin(c.relay), deviceId: c.deviceId, deviceToken: c.deviceToken, bindings };
}
