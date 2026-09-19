import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketplace, searchMarketplace } from '../src/runtime/plugin-marketplace.ts';

const idle = () => new AbortController().signal;
const candidate = (name: string) => ({ package: { name, version: '1.2.3', keywords: ['dsh-plugin'] } });
const manifest = (name: string, extra: object = {}) => ({ name, version: '1.2.3', dsh: { bundle: { patch: './bundle.yml' } }, ...extra });
const counts = (name: string, extra: object = {}) => ({ package: name, downloads: 1234, start: '2026-08-18', end: '2026-09-16', ...extra });
const packageName = '@test/memory';
const metadataFetcher = (metadata: object, downloads: (url: URL, init: RequestInit) => Response | Promise<Response>) => async (input: string, init: RequestInit) => {
  const url = new URL(input);
  if (url.origin === 'https://api.npmjs.org') return downloads(url, init);
  assert.equal(url.origin, 'https://registry.npmjs.org');
  return Response.json(url.pathname === '/-/v1/search' ? { total: 1, objects: [candidate(packageName)] } : manifest(packageName, metadata));
};
const noCounts = () => new Response('', { status: 404 });

test('downloads use the fixed public npm endpoint and preserve the exact inclusive range, including zero', async () => {
  for (const count of [0, 1234]) {
    const result = await searchMarketplace({ query: '' }, idle(), { fetch: metadataFetcher({}, (url, init) => {
      assert.equal(url.href, 'https://api.npmjs.org/downloads/point/last-month/%40test%2Fmemory');
      assert.equal(init.redirect, 'error');
      return Response.json(counts(packageName, { downloads: count }));
    }) });
    assert.deepEqual(result.items[0].downloads, { count, start: '2026-08-18', end: '2026-09-16' });
    assert.equal(result.items[0].compatibility, 'unknown');
  }
});

test('optional download errors and invalid statistics never erase a verified plugin', async () => {
  const responses = [
    () => new Response('', { status: 429 }), () => new Response('', { status: 500 }),
    () => Response.json(counts('different')), () => Response.json(counts(packageName, { downloads: -1 })),
    () => Response.json(counts(packageName, { downloads: 1.5 })), () => Response.json(counts(packageName, { downloads: Number.MAX_SAFE_INTEGER + 1 })),
    () => Response.json(counts(packageName, { start: '2026-02-30' })), () => Response.json(counts(packageName, { start: '2026-13-01' })),
    () => Response.json(counts(packageName, { start: '2026-09-17' })), () => Response.json(counts(packageName, { end: 'yesterday' })),
    () => new Response('invalid', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '32769' } }),
    () => new Response(' '.repeat(32769), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of responses) {
    const result = await searchMarketplace({ query: '' }, idle(), { fetch: metadataFetcher({}, response) });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].downloads, undefined);
    assert.equal(result.warning, undefined, 'Unavailable popularity metadata is not a package verification failure');
  }
});

test('download enrichment has an independent bounded deadline and cancellation still stops a search', async () => {
  let cancelled = false;
  const fetcher = metadataFetcher({}, (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => { cancelled = true; reject(init.signal!.reason); }, { once: true });
  }));
  const result = await searchMarketplace({ query: '' }, idle(), { fetch: fetcher, downloadsTimeoutMs: 15 });
  assert.equal(cancelled, true);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].downloads, undefined);
  const abort = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = handleMarketplace('search', { args: { query: '' } }, abort.signal, { fetch: metadataFetcher({}, (_url, init) => {
    entered();
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  }) });
  await ready; abort.abort();
  const stopped = await pending;
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.equal(stopped.error.code, 'marketplace/cancelled');
});

test('download work is bounded to four requests and only verifies visible bundle identities', async () => {
  let active = 0; let peak = 0; const requested: string[] = [];
  const names = Array.from({ length: 12 }, (_, index) => `plugin-${index}`);
  const result = await searchMarketplace({ query: '' }, idle(), { fetch: async (input, init) => {
    const url = new URL(input);
    if (url.origin === 'https://api.npmjs.org') {
      const name = decodeURIComponent(url.pathname.split('/').at(-1)!); requested.push(name);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      assert.equal(init.signal!.aborted, false);
      return Response.json(counts(name));
    }
    if (url.pathname === '/-/v1/search') return Response.json({ total: 12, objects: names.map(candidate) });
    const name = url.pathname.split('/')[1];
    return Response.json(name === 'plugin-11' ? { name, version: '1.2.3' } : manifest(name));
  } });
  assert.equal(peak, 4);
  assert.deepEqual(requested, names.slice(0, 11));
  assert.deepEqual(result.items.map(item => item.name), names.slice(0, 11));
  assert.ok(result.items.every(item => item.downloads?.count === 1234));
});

test('published GitHub transport and shorthand forms canonicalize to an explicit HTTPS repository', async () => {
  for (const repository of [
    'git+https://github.com/Owner/repo.name.git', 'https://github.com/Owner/repo.name.git/',
    'git://github.com/Owner/repo.name.git', 'git@github.com:Owner/repo.name.git',
    'github:Owner/repo.name', 'git+ssh://git@github.com/Owner/repo.name.git#main',
    { type: 'git', url: 'git+https://github.com/Owner/repo.name.git', directory: 'packages/plugin' },
  ]) {
    const result = await searchMarketplace({ query: '' }, idle(), { fetch: metadataFetcher({ repository }, noCounts) });
    assert.equal(result.items[0].repository, 'https://github.com/Owner/repo.name');
    assert.equal(result.items[0].githubUrl, 'https://github.com/Owner/repo.name');
  }
});

test('GitHub identity is never guessed from a lookalike host, webpage, encoded identity or path traversal', async () => {
  for (const repository of [
    'https://github.com.evil.test/o/r', 'https://github.com./o/r', 'https://www.github.com/o/r',
    'https://github.com:8443/o/r', 'https://github.com/o/r/tree/main/plugin', 'https://github.com/o',
    'https://github.com/o/x/../r', 'https://github.com/o%2Fr/other', 'https://github.com/o/.git',
  ]) {
    const result = await searchMarketplace({ query: '' }, idle(), { fetch: metadataFetcher({ repository }, noCounts) });
    assert.equal(result.items[0].githubUrl, undefined, repository);
  }
  for (const repository of [
    'https://secret@github.com/o/r', 'https://github.com@evil.test/o/r', 'https://%67ithub.com/o/r',
    'https://git\thub.com/o/r', 'https://github.com\\o\\r', 'javascript:alert(1)', 'file:///repo',
    'git://gitlab.com/o/r', 'git@gitlab.com:o/r',
  ]) {
    const result = await searchMarketplace({ query: '' }, idle(), { fetch: metadataFetcher({ repository }, noCounts) });
    assert.equal(result.items[0].repository, undefined, repository);
    assert.equal(result.items[0].githubUrl, undefined, repository);
  }
  const other = await searchMarketplace({ query: '' }, idle(), { fetch: metadataFetcher({ repository: 'git+https://gitlab.com/team/plugin.git' }, noCounts) });
  assert.equal(other.items[0].repository, 'https://gitlab.com/team/plugin.git');
  assert.equal(other.items[0].githubUrl, undefined);
});
