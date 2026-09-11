import { externalWebUrl } from './desktop-api.ts';

export type BrowserTarget = { kind: 'web'; url: string } | { kind: 'preview'; address: string; sessionId: string; cwd?: string };
export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserState = { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string };
export type BrowserAction = 'back' | 'forward' | 'reload' | 'stop';
export const BROWSER_TAB_ID = 'dsh-desktop-browser';
export const PREVIEW_TAB_ID = 'dsh-desktop-preview';
const WEB_PREFIX = 'dsh-resource://web/';

export function webAddress(value: string): string {
  const url = externalWebUrl(value);
  if (!url) throw new Error('请输入有效的 HTTP 或 HTTPS 网址。');
  return WEB_PREFIX + encodeURIComponent(url);
}

export function webUrlOf(address: string): string | undefined {
  if (!address.startsWith(WEB_PREFIX)) return undefined;
  try { return externalWebUrl(decodeURIComponent(address.slice(WEB_PREFIX.length))); }
  catch { return undefined; }
}

export function previewFileOf(address: string, sessionId: string): { path: string; relative: boolean } | undefined {
  try {
    const prefix = 'dsh-resource://file/';
    if (!address.startsWith(prefix) || /[?#]/.test(address)) return undefined;
    // Read the original segments: URL parsing would erase dot-segment traversal.
    const [scope, ...parts] = address.slice(prefix.length).split('/');
    if (scope === 'session' && decodeURIComponent(parts.shift() ?? '') !== sessionId) return undefined;
    if (scope !== 'session' && scope !== 'absolute') return undefined;
    const segments = parts.map(decodeURIComponent);
    if (segments.some(part => part === '..' || /[\\/\0]/.test(part))) return undefined;
    const path = segments.join('/');
    const drive = /^[A-Za-z]:\//.test(path);
    if (!path || (/^[A-Za-z]:/.test(path) && !drive)) return undefined;
    // The core file API also keeps workspace-external paths in their owning session.
    return { path: scope === 'absolute' && !drive ? '/' + path : path, relative: scope === 'session' && !drive && !path.startsWith('/') };
  } catch { return undefined; }
}

export function browserTitle(address: string): string {
  const url = webUrlOf(address);
  if (url) return new URL(url).hostname;
  try { return decodeURIComponent(address.slice(address.lastIndexOf('/') + 1)) || '浏览器'; }
  catch { return '浏览器'; }
}

export function validBrowserId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && /^[\w:.-]+$/.test(id);
}

export function browserBounds(value: unknown, zoom: number, viewport: { width: number; height: number }): BrowserBounds | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as BrowserBounds;
  if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) return undefined;
  const x = Math.max(0, Math.round(r.x * zoom)), y = Math.max(0, Math.round(r.y * zoom));
  const right = Math.min(viewport.width, Math.round((r.x + r.width) * zoom));
  const bottom = Math.min(viewport.height, Math.round((r.y + r.height) * zoom));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}
