import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { RemoteCredentials } from '../shared/remote-access.ts';

export type CollabGrant = { origin: string; ca?: string; token: string; expiresAt: number };
export type CollabBroker = { grant(): Promise<CollabGrant> };

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
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(typeof value.error === 'string' ? value.error : `协作请求失败（HTTP ${res.statusCode}）。`) as Error & { status: number; code?: string };
            error.status = res.statusCode ?? 500; error.code = value.error; reject(error);
          } else resolve(value);
        } catch { reject(new Error(`协作服务响应无效（HTTP ${res.statusCode}）。`)); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('协作请求超时，请重试。')));
    req.on('error', reject); req.end(payload);
  });
}

export function createCollabBroker(credentials: () => RemoteCredentials | undefined): CollabBroker {
  let cached: CollabGrant | undefined, owner: RemoteCredentials | undefined;
  let pending: Promise<CollabGrant> | undefined, generation = 0;
  return { async grant() {
    const current = credentials();
    if (!current) throw new Error('请先在远程连接设置中注册中继，再使用 P2P 协作。');
    if (owner?.relay !== current.relay || owner?.deviceId !== current.deviceId || owner?.deviceToken !== current.deviceToken || owner?.relayCa !== current.relayCa) { cached = undefined; pending = undefined; owner = current; generation++; }
    if (cached && cached.expiresAt > Date.now() + 45000) return cached;
    const started = generation;
    if (!pending) pending = (async () => {
      const value = await collabJson(current.relay + '/v1/collab-token', current.deviceToken, { deviceId: current.deviceId }, current.relayCa);
      if (typeof value.token !== 'string' || value.token.length > 2048 || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()) throw new Error('中继协作凭据无效，请检查中继版本。');
      const grant: CollabGrant = { origin: current.relay, ca: current.relayCa, token: value.token, expiresAt: value.expiresAt };
      if (generation !== started) throw new Error('中继配置已变化，请重试。');
      cached = grant;
      return grant;
    })().finally(() => { if (generation === started) pending = undefined; });
    return pending;
  } };
}
