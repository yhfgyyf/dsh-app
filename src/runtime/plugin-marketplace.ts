import type { MarketplaceErrorCode, MarketplaceItem, MarketplaceResult, MarketplaceRpcResult } from '../shared/plugin-marketplace.ts';

export const name = 'dsh-desktop-plugin-marketplace';
export const inject = ['connection'];
const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS_API = 'https://api.npmjs.org/downloads/point/last-month/';
const PAGE_SIZE = 12;
const MAX_PAGE = 49;
const MAX_JSON_BYTES = 1024 * 1024;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const packageVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
type JsonObject = Record<string, unknown>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type SearchOptions = { fetch?: Fetcher; timeoutMs?: number; downloadsTimeoutMs?: number };

class MarketplaceError extends Error {
  code: MarketplaceErrorCode;
  constructor(code: MarketplaceErrorCode, message: string) { super(message); this.code = code; }
}
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function text(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;
}
function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value.replace(/^git\+/, ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}
function repositoryLinks(value: unknown): { repository?: string; githubUrl?: string } {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return {};
  const source = value.replace(/^git\+/, '');
  const candidate = source
    .replace(/^github:/i, 'https://github.com/')
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^git:\/\/github\.com\//i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/');
  if (/^https?:\/\/[^/?#]*%/i.test(candidate)) return {};
  const safe = webUrl(candidate);
  if (!safe) return {};
  const url = new URL(safe);
  // A root must be explicit; never guess it from an arbitrary tree, issue or URL path.
  const match = url.pathname.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})\/?$/);
  if (url.hostname.toLowerCase() === 'github.com' && !url.port && match && !source.includes('%') && !source.split(/[?#]/, 1)[0].split('/').some(part => part === '.' || part === '..')) {
    const repo = match[2].replace(/\.git$/, '');
    if (repo && repo !== '.' && repo !== '..') {
      const githubUrl = `https://github.com/${match[1]}/${repo}`;
      return { repository: githubUrl, githubUrl };
    }
  }
  return { repository: safe };
}
function requestOf(value: unknown): { query: string; page: number } {
  const input = object(value);
  if (!input || Object.keys(input).some(key => key !== 'query' && key !== 'page') || typeof input.query !== 'string' || input.query.length > 100 || /[\u0000-\u001f\u007f]/.test(input.query)) {
    throw new MarketplaceError('marketplace/invalid-query', '搜索内容须为最多 100 个字符的文本。');
  }
  const page = input.page === undefined ? 0 : input.page;
  if (!Number.isInteger(page) || typeof page !== 'number' || page < 0 || page > MAX_PAGE) {
    throw new MarketplaceError('marketplace/invalid-query', '搜索页码须为 0 到 49 的整数。');
  }
  return { query: input.query.trim(), page };
}
async function readJson(url: string, signal: AbortSignal, fetcher: Fetcher, limit = MAX_JSON_BYTES): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetcher(url, { signal, redirect: 'error', headers: { accept: 'application/json' } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new MarketplaceError('marketplace/unavailable', response.status === 429 ? 'npm 暂时限制了请求频率，请稍后重试。' : `npm 请求失败（HTTP ${response.status}），请稍后重试。`);
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || Number(response.headers.get('content-length')) > limit || !response.body) {
    await response.body?.cancel();
    throw new MarketplaceError('marketplace/invalid-response', 'npm 返回的数据格式无效或超出大小限制。');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new MarketplaceError('marketplace/invalid-response', 'npm 返回的数据超出大小限制。');
      }
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw new MarketplaceError('marketplace/invalid-response', 'npm 返回的数据不是有效 JSON。'); }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
function candidateOf(value: unknown): JsonObject | undefined {
  const pkg = object(object(value)?.package);
  if (!pkg || typeof pkg.name !== 'string' || pkg.name.length > 214 || !packageName.test(pkg.name)
    || typeof pkg.version !== 'string' || pkg.version.length > 100 || !packageVersion.test(pkg.version)
    || !Array.isArray(pkg.keywords) || !pkg.keywords.some(keyword => keyword === 'dsh-plugin')) return undefined;
  return pkg;
}
function bundleItem(candidate: JsonObject, value: unknown): MarketplaceItem | undefined {
  const manifest = object(value);
  if (!manifest || manifest.name !== candidate.name || manifest.version !== candidate.version || manifest.deprecated) return undefined;
  const patch = object(object(manifest.dsh)?.bundle)?.patch;
  if (typeof patch !== 'string' || !patch.trim() || patch.length > 256 || patch.startsWith('/') || patch.includes('\\') || patch.includes(':') || patch.split('/').includes('..')) return undefined;
  const links = object(candidate.links);
  const homepage = webUrl(manifest.homepage) ?? webUrl(links?.homepage);
  const primaryRepository = repositoryLinks(object(manifest.repository)?.url ?? manifest.repository);
  const repositories = primaryRepository.repository ? primaryRepository : repositoryLinks(links?.repository);
  const author = text(object(candidate.publisher)?.username, 120) ?? text(object(manifest.author)?.name, 120);
  const name = manifest.name as string;
  return {
    name, version: manifest.version as string,
    description: text(manifest.description, 1200) ?? text(candidate.description, 1200) ?? '',
    npmUrl: `https://www.npmjs.com/package/${name}`,
    ...(homepage ? { homepage } : {}), ...repositories, ...(author ? { author } : {}),
    compatibility: 'unknown', bundleVerified: true,
  };
}

function dateOf(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;
}
async function addDownloads(items: MarketplaceItem[], callerSignal: AbortSignal, fetcher: Fetcher, timeoutMs: number): Promise<void> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = AbortSignal.any([callerSignal, timeout.signal]);
  let cursor = 0;
  async function worker() {
    while (!signal.aborted) {
      const item = items[cursor++];
      if (!item) return;
      try {
        const counts = object(await readJson(DOWNLOADS_API + encodeURIComponent(item.name), signal, fetcher, 32 * 1024));
        if (counts?.package === item.name && typeof counts.downloads === 'number' && Number.isSafeInteger(counts.downloads) && counts.downloads >= 0
          && dateOf(counts.start) && dateOf(counts.end) && counts.start <= counts.end) {
          item.downloads = { count: counts.downloads, start: counts.start, end: counts.end };
        }
      } catch {
        // Optional popularity metadata must never erase a verified search result.
      }
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker())); }
  finally { clearTimeout(timer); }
  callerSignal.throwIfAborted();
}

/** Search public npm metadata only; installing and enabling belong to official PluginManager. */
export async function searchMarketplace(input: unknown, callerSignal: AbortSignal, options: SearchOptions = {}): Promise<MarketplaceResult> {
  const { query, page } = requestOf(input);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 15000);
  const signal = AbortSignal.any([callerSignal, timeout.signal]);
  const fetcher = options.fetch ?? fetch;
  try {
    const url = new URL('/-/v1/search', REGISTRY);
    url.search = new URLSearchParams({ text: `keywords:dsh-plugin${query ? ` ${query}` : ''}`, size: String(PAGE_SIZE), from: String(page * PAGE_SIZE) }).toString();
    const body = object(await readJson(url.href, signal, fetcher));
    if (!body || !Array.isArray(body.objects) || body.objects.length > PAGE_SIZE || typeof body.total !== 'number' || !Number.isSafeInteger(body.total) || body.total < 0) {
      throw new MarketplaceError('marketplace/invalid-response', 'npm 搜索结果格式无效，请稍后重试。');
    }
    const candidates = body.objects.map(candidateOf);
    const verified: (MarketplaceItem | undefined)[] = new Array(candidates.length);
    const seen = new Set<string>();
    let cursor = 0;
    let unavailable = 0;
    async function worker() {
      for (;;) {
        signal.throwIfAborted();
        const index = cursor++;
        if (index >= candidates.length) return;
        const candidate = candidates[index];
        if (!candidate || seen.has(candidate.name as string)) continue;
        seen.add(candidate.name as string);
        try {
          const metadata = await readJson(`${REGISTRY}/${encodeURIComponent(candidate.name as string)}/${encodeURIComponent(candidate.version as string)}`, signal, fetcher);
          verified[index] = bundleItem(candidate, metadata);
        } catch (error) {
          signal.throwIfAborted();
          // A registry outage is different from a package that declares no DSH bundle.
          unavailable++;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
    const items = verified.filter((item): item is MarketplaceItem => item !== undefined);
    if (unavailable > 0 && items.length === 0) throw new MarketplaceError('marketplace/unavailable', '暂时无法核验 npm 插件信息，请稍后重试。');
    signal.throwIfAborted();
    clearTimeout(timer);
    await addDownloads(items, callerSignal, fetcher, options.downloadsTimeoutMs ?? 4000);
    return {
      items, page, pageSize: PAGE_SIZE, total: body.total, source: 'npm',
      hasMore: page < MAX_PAGE && (page + 1) * PAGE_SIZE < body.total,
      skipped: candidates.length - items.length,
      ...(unavailable ? { warning: '部分插件的信息暂时无法核验，已暂不显示；可重试。' } : {}),
    };
  } catch (error) {
    if (callerSignal.aborted) throw new MarketplaceError('marketplace/cancelled', '插件搜索已取消。');
    if (timeout.signal.aborted) throw new MarketplaceError('marketplace/timeout', 'npm 搜索超时，请稍后重试。');
    if (error instanceof MarketplaceError) throw error;
    throw new MarketplaceError('marketplace/unavailable', '无法连接 npm 插件目录，请检查网络后重试。');
  } finally { clearTimeout(timer); }
}

export async function handleMarketplace(endpoint: string, payload: unknown, signal: AbortSignal, options: SearchOptions = {}): Promise<MarketplaceRpcResult> {
  try {
    if (endpoint !== 'search') throw new MarketplaceError('marketplace/not-found', '不支持此插件市场操作。');
    const body = object(payload);
    if (!body || Object.keys(body).some(key => key !== 'args')) throw new MarketplaceError('marketplace/invalid-query', '插件搜索参数无效。');
    return { ok: true, value: await searchMarketplace(body.args, signal, options) };
  } catch (error) {
    const failure = error instanceof MarketplaceError ? error : new MarketplaceError('marketplace/unavailable', '插件搜索失败，请稍后重试。');
    return { ok: false, error: { code: failure.code, message: failure.message, details: {} } };
  }
}

type RuntimeContext = {
  connection: { rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<MarketplaceRpcResult>): () => void | Promise<void> } };
  effect(factory: () => (() => void | Promise<void>), label?: string): unknown;
};
export function apply(ctx: RuntimeContext) {
  ctx.effect(() => ctx.connection.rpc.handle('/desktop-marketplace', handleMarketplace), name);
}
