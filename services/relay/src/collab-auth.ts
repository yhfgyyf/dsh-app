import { createHmac, timingSafeEqual } from 'node:crypto';
import { CollabError, idField, numberField, record, type CollabIdentity } from './collab-types.js';

/** A short-lived, collaboration-only grant, never accepted by remote-control routes. */
export function issueCollabGrant(identity: Omit<CollabIdentity, 'expiresAt'>, secret: string, now = Date.now()) {
  requireCollabSecret(secret);
  const claims = { ...identity, purpose: 'dsh-collab-v1', expiresAt: now + 5 * 60_000 };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { token: body + '.' + createHmac('sha256', secret).update(body).digest('base64url'), expiresAt: claims.expiresAt };
}
export function requireCollabSecret(secret: string | undefined): asserts secret is string {
  if (!secret || Buffer.byteLength(secret) < 32) throw new CollabError(503, 'collaboration_not_configured');
}
export function verifyCollabGrant(token: string, secret: string, now = Date.now()): CollabIdentity {
  requireCollabSecret(secret);
  try {
    if (token.length > 2048) throw new Error();
    const [body, mac, extra] = token.split('.');
    if (!body || !mac || extra !== undefined) throw new Error();
    const wanted = createHmac('sha256', secret).update(body).digest(), supplied = Buffer.from(mac, 'base64url');
    if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) throw new Error();
    const r = record(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (r.purpose !== 'dsh-collab-v1' || !['desktop', 'mobile'].includes(r.kind as string) || !['viewer', 'control'].includes(r.role as string) || numberField(r.expiresAt) <= now) throw new Error();
    if (r.kind === 'desktop' && (r.role !== 'control' || r.bindingId !== undefined)) throw new Error();
    return { deviceId: idField(r.deviceId), kind: r.kind as CollabIdentity['kind'], role: r.role as CollabIdentity['role'], expiresAt: r.expiresAt as number,
      ...(r.kind === 'mobile' ? { bindingId: idField(r.bindingId) } : {}) };
  } catch { throw new CollabError(401, 'invalid_collaboration_grant'); }
}
