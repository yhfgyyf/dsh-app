import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserTarget } from '../shared/sidebar-browser.ts';
import { previewFileOf } from '../shared/sidebar-browser.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};
const DOCUMENTS = new Set(['.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);
const within = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };

/** One explicitly opened document grants web assets in its own directory only. */
export async function previewGrant(target: Extract<BrowserTarget, { kind: 'preview' }>) {
  const file = previewFileOf(target.address, target.sessionId);
  if (!file || (file.relative && (!target.cwd || !isAbsolute(target.cwd)))) throw new Error('无法定位此会话的预览文件。');
  const requested = file.relative ? resolve(target.cwd!, file.path) : file.path;
  if (!isAbsolute(requested) || !DOCUMENTS.has(extname(requested).toLowerCase())) throw new Error('此文件使用文本查看器打开。');
  const path = await realpath(requested), root = dirname(path), host = randomUUID();
  const url = `dsh-preview://${host}/${encodeURIComponent(path.slice(root.length + 1))}`;
  return {
    url, path, host,
    async read(request: Request): Promise<Response> {
      const address = new URL(request.url);
      if (address.protocol !== 'dsh-preview:' || address.host !== host || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
      try {
        const parts = address.pathname.split('/').slice(1).map(decodeURIComponent);
        if (parts.some(part => part.startsWith('.') || /[\\/\0]/.test(part))) return new Response(null, { status: 403 });
        const asset = await realpath(resolve(root, ...parts));
        const type = TYPES[extname(asset).toLowerCase()];
        if (!within(root, asset) || !type || !(await stat(asset)).isFile()) return new Response(null, { status: 403 });
        return new Response(request.method === 'HEAD' ? null : await readFile(asset), { headers: {
          'content-type': type, 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self' data: blob: https: http:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http:; style-src 'self' 'unsafe-inline' https: http:; object-src 'none'; base-uri 'self'",
        } });
      } catch { return new Response(null, { status: 404 }); }
    },
  };
}
