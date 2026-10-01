export type ClientEndpoint = { origin: string; network: 'private' | 'public' };

/** These are administrator-supplied aliases of this instance, never forwarded request headers. */
export function parseClientEndpoints(value: unknown): ClientEndpoint[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) throw new Error('RELAY_CLIENT_ENDPOINTS requires 1–6 entries');
  const seen = new Set<string>();
  return value.map(entry => {
    if (!entry || !['private', 'public'].includes(entry.network) || typeof entry.origin !== 'string' ||
        entry.origin.length > 256 || /[\\\s]/.test(entry.origin)) throw new Error('Invalid relay client endpoint');
    const url = new URL(entry.origin);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('Relay client endpoints must be HTTPS origins');
    }
    if (seen.has(url.origin)) throw new Error('Duplicate relay client endpoint');
    seen.add(url.origin);
    return { origin: url.origin, network: entry.network };
  });
}
