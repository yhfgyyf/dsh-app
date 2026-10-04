import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { RemoteCredentials } from '../shared/remote-access.ts';

export type CollabGrant = { origin: string; ca?: string; token: string; expiresAt: number; deviceId?: string };
export type CollabBroker = { isRegistered(): boolean; grant(): Promise<CollabGrant> };

/** Bounded native requests with the relay's pinned CA and no redirects or renderer credentials. */
export function collabJson(url: string, token: string, body?: unknown, ca?: string, signal?: AbortSignal): Promise<any> {
  const target = new URL(url), payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (target.username || target.password || (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))) return Promise.reject(new Error('协作连接必须使用 HTTPS。'));
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: body === undefined ? 'GET' : 'POST', signal,
      ...(ca ? { ca, rejectUnauthorized: true } : {}),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 12 * 1024 * 1024) req.destroy(new Error('协作响应超过大小限制。')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        let value: any;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          // Never echo arbitrary server text or credential material into the renderer or run logs.
          const candidate = value?.error, recoverySecret = (body as { recoverySecret?: unknown } | undefined)?.recoverySecret;
          const code = typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(candidate) && !candidate.includes(token) && !(typeof recoverySecret === 'string' && candidate.includes(recoverySecret)) ? candidate : undefined;
          const error = new Error(code ?? `协作请求失败（HTTP ${res.statusCode}）。`) as Error & { status: number; code?: string };
          error.status = res.statusCode ?? 500; if (code) error.code = code; reject(error);
        } else if (value === undefined) reject(new Error(`协作服务响应无效（HTTP ${res.statusCode}）。`));
        else resolve(value);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('协作请求超时，请重试。')));
    req.on('error', reject); req.end(payload);
  });
}

export function createCollabBroker(credentials: () => RemoteCredentials | undefined): CollabBroker {
  let cached: CollabGrant | undefined, owner: RemoteCredentials | undefined;
  let pending: Promise<CollabGrant> | undefined, generation = 0;
  return { isRegistered: () => !!credentials(), async grant() {
    const source = credentials();
    if (!source) { cached = undefined; pending = undefined; owner = undefined; generation++; throw new Error('请先在插件 → dsh-p2p-collab 详情中注册中继，再开启协作空间。'); }
    const current = { ...source };
    if (owner?.relay !== current.relay || owner?.deviceId !== current.deviceId || owner?.deviceToken !== current.deviceToken || owner?.relayCa !== current.relayCa) { cached = undefined; pending = undefined; owner = current; generation++; }
    if (cached && cached.expiresAt > Date.now() + 45000) return cached;
    const started = generation;
    if (!pending) pending = (async () => {
      let value: any;
      try { value = await collabJson(current.relay + '/v1/collab-token', current.deviceToken, { deviceId: current.deviceId }, current.relayCa); }
      catch (error) {
        if ([404, 405].includes((error as { status?: number }).status ?? 0)) throw Object.assign(new Error('此中继未提供协作认证接口，请先升级中继。'), { code: 'collaboration_not_supported', status: (error as { status: number }).status });
        throw error;
      }
      if (typeof value.token !== 'string' || value.token.length > 2048 || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()) throw new Error('中继协作凭据无效，请检查中继版本。');
      const grant: CollabGrant = { origin: current.relay, ca: current.relayCa, token: value.token, expiresAt: value.expiresAt, deviceId: current.deviceId };
      const latest = credentials();
      if (generation !== started || !latest || latest.relay !== current.relay || latest.deviceId !== current.deviceId || latest.deviceToken !== current.deviceToken || latest.relayCa !== current.relayCa) throw new Error('中继配置已变化，请重试。');
      cached = grant;
      return grant;
    })().finally(() => { if (generation === started) pending = undefined; });
    return pending;
  } };
}
