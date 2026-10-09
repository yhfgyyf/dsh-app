import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import { request } from 'node:https';
import { relayOrigin } from '../shared/remote-access.ts';

export function parseRegistrationCode(value: unknown): { code: string; fingerprint?: string } {
  if (typeof value !== 'string') throw new Error('注册码无效。');
  const code = value.trim();
  if (code.startsWith('dshca1_')) {
    const match = /^dshca1_([a-fA-F0-9]{64})_([A-Za-z0-9_-]{43})$/.exec(code);
    if (!match) throw new Error('带 CA 指纹的注册码不完整，请复制管理员提供的完整注册码。');
    return { code: match[2], fingerprint: match[1].toLowerCase() };
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(code)) throw new Error('注册码无效。');
  return { code };
}

/** Retrieve public certificates only. No HTTP request or credential is sent until the pinned CA is verified. */
export async function retrieveRelayCa(origin: string, fingerprint: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('自动配置 CA 需要有效证书指纹。');
  return retrievePinnedCa(origin, cert => cert.fingerprint256.replaceAll(':', '').toLowerCase() === fingerprint);
}

/** A renamed CA may retain its trusted key. A different key always requires explicit registration. */
export async function renewRelayCa(origin: string, trustedCa: string): Promise<string> {
  const trusted = new X509Certificate(trustedCa);
  if (!trusted.ca || trusted.subject !== trusted.issuer || !trusted.verify(trusted.publicKey)) throw new Error('已保存的中继 CA 无效。');
  const key = trusted.publicKey.export({ type: 'spki', format: 'der' });
  return retrievePinnedCa(origin, cert => cert.publicKey.export({ type: 'spki', format: 'der' }).equals(key));
}

async function retrievePinnedCa(origin: string, matches: (cert: X509Certificate) => boolean): Promise<string> {
  const url = new URL(relayOrigin(origin));
  if (url.protocol !== 'https:') throw new Error('自动配置 CA 需要 HTTPS 中继。');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: Number(url.port) || 443, servername: isIP(host) ? undefined : host, rejectUnauthorized: false }, () => {
      try {
        let peer = socket.getPeerCertificate(true);
        const seen = new Set<string>();
        for (let i = 0; i < 16 && peer?.raw; i++) {
          if (peer.raw.length > 16384) throw new Error('中继 CA 证书过大。');
          const cert = new X509Certificate(peer.raw), actual = cert.fingerprint256.replaceAll(':', '').toLowerCase();
          if (seen.has(actual)) break;
          seen.add(actual);
          if (matches(cert)) {
            if (!cert.ca || cert.subject !== cert.issuer || !cert.verify(cert.publicKey)) throw new Error('必须使用中继的根 CA 证书。');
            if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new Error('中继 CA 证书已过期或尚未生效。');
            resolve(cert.toString()); return;
          }
          peer = peer.issuerCertificate;
        }
        throw new Error('中继证书链与信任的 CA 不匹配，请确认 CA 指纹及服务端证书链。');
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
    const timer = setTimeout(() => socket.destroy(new Error('下载中继 CA 证书超时，请检查中继地址和网络。')), 10000);
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timer));
  });
}

export function isUntrustedRelayCaError(error: unknown): boolean {
  let cause: any = error;
  for (let i = 0; i < 6 && cause; i++, cause = cause.cause) {
    if (['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(cause.code)) return true;
  }
  return false;
}

/** The CA applies only to this request. Normal hostname, chain and validity checks remain enabled. */
export function fetchWithRelayCa(url: string, headers: Record<string, string>, body: string, ca: string): Promise<Response> {
  if (new URL(url).protocol !== 'https:') throw new Error('中继 CA 只能用于 HTTPS。');
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers, ca, rejectUnauthorized: true, signal: AbortSignal.timeout(10000) }, res => {
      void (async () => {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of res) {
          size += chunk.length;
          if (size > 65536) { req.destroy(); throw new Error('中继响应过大。'); }
          chunks.push(Buffer.from(chunk));
        }
        return new Response(size ? Buffer.concat(chunks) : null, { status: res.statusCode ?? 502 });
      })().then(resolve, reject);
    });
    req.once('error', reject);
    req.end(body);
  });
}

export function relayConnectionError(error: unknown): unknown {
  if (isUntrustedRelayCaError(error)) return new Error('中继 CA 证书尚未受信任，请使用管理员生成的带 CA 指纹注册码，自动配置安全连接。');
  let cause: any = error;
  for (let i = 0; i < 6 && cause; i++, cause = cause.cause) {
    if (cause.code === 'ERR_TLS_CERT_ALTNAME_INVALID') return new Error('中继证书与填写的 IP 或域名不匹配，请检查中继地址和服务端证书。');
    if (['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'].includes(cause.code)) return new Error('中继证书已过期或尚未生效，请检查系统时间和服务端证书。');
  }
  return error;
}
