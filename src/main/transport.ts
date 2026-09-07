import { DESKTOP_ASSET_PREFIX } from '../shared/dsh-boot.ts';

type Asset = { body: Uint8Array; contentType: string };
export type DshTransportOptions = {
  getEndpoint: () => string;
  fetch: (request: Request) => Promise<Response>;
  getAsset: (name: string) => Promise<Asset | undefined>;
};

/** Serve the desktop's own document; only RPC and core module assets use loopback HTTP. */
export function createDshTransport(options: DshTransportOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== options.getEndpoint()) return options.fetch(request);
    const name = url.pathname === '/' ? 'app/index.html' : url.pathname.startsWith(DESKTOP_ASSET_PREFIX) ? url.pathname.slice(DESKTOP_ASSET_PREFIX.length) : undefined;
    if (name === undefined) return options.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    // getAsset reads a startup allowlist, never a renderer-supplied filesystem path.
    const asset = await options.getAsset(name);
    if (!asset) return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : asset.body as BodyInit, {
      headers: { 'content-type': asset.contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  };
}
