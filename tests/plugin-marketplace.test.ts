import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, handleMarketplace, searchMarketplace } from '../src/runtime/plugin-marketplace.ts';

const idle = () => new AbortController().signal;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const candidate = (name = 'dsh-market-test', extra: object = {}) => ({ package: { name, version: '1.2.3', description: 'Candidate description', keywords: ['dsh-plugin'], ...extra } });
const manifest = (name = 'dsh-market-test', extra: object = {}) => ({ name, version: '1.2.3', description: 'Manifest description', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...extra });
const invoke = (args: unknown, fetcher: (input: string, init: RequestInit) => Promise<Response>, signal = idle(), timeoutMs?: number) => handleMarketplace('search', { args }, signal, { fetch: fetcher, timeoutMs });

test('remote candidates are verified at the exact registry version and retain safe source metadata', async () => {
  const urls: URL[] = [];
  const result = await invoke({ query: '记忆 & query=x', page: 1 }, async (input, init) => {
    const url = new URL(input); urls.push(url);
    if (url.origin === 'https://api.npmjs.org') return new Response('', { status: 404 });
    assert.equal(url.origin, 'https://registry.npmjs.org');
    assert.equal(init.redirect, 'error');
    if (url.pathname === '/-/v1/search') return json({ total: 100, objects: [candidate('@test/memory', { publisher: { username: 'author', email: 'not-returned@example.test' } })] });
    return json(manifest('@test/memory', { homepage: 'https://example.test/home', repository: { url: 'git+https://github.com/test/memory.git' } }));
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(urls[0].searchParams.get('text'), 'keywords:dsh-plugin 记忆 & query=x');
  assert.equal(urls[0].searchParams.get('from'), '12');
  assert.equal(urls[1].pathname, '/%40test%2Fmemory/1.2.3');
  assert.deepEqual(result.value.items[0], { name: '@test/memory', version: '1.2.3', description: 'Manifest description', npmUrl: 'https://www.npmjs.com/package/@test/memory', homepage: 'https://example.test/home', repository: 'https://github.com/test/memory', githubUrl: 'https://github.com/test/memory', author: 'author', compatibility: 'unknown', bundleVerified: true });
  assert.equal(result.value.hasMore, true);
});

test('ordinary packages, untrusted identities, deprecated packages and nonlocal bundle paths are filtered', async () => {
  const objects = [candidate('plain'), candidate('mismatch'), candidate('deprecated'), candidate('escape'), candidate('no-keyword', { keywords: ['plugin'] }), candidate('../escape'), candidate('valid')];
  const seen: string[] = [];
  const result = await invoke({ query: '' }, async input => {
    const url = new URL(input);
    if (url.pathname === '/-/v1/search') return json({ total: objects.length, objects });
    const name = decodeURIComponent(url.pathname.split('/')[1]); seen.push(name);
    if (name === 'plain') return json({ name, version: '1.2.3' });
    if (name === 'mismatch') return json(manifest('different'));
    if (name === 'deprecated') return json(manifest(name, { deprecated: 'retired' }));
    if (name === 'escape') return json(manifest(name, { dsh: { bundle: { patch: '../outside.yml' } } }));
    return json(manifest(name));
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.items.map(item => item.name), ['valid']);
  assert.equal(result.value.skipped, 6);
  assert.equal(seen.includes('no-keyword'), false);
  assert.equal(seen.includes('../escape'), false);
  assert.equal(result.value.hasMore, false);
});

test('input validation rejects large/control text, invalid pages, extra URLs and unsupported mutation methods before fetching', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return json({}); };
  for (const args of [null, {}, { query: 5 }, { query: 'x'.repeat(101) }, { query: '\u0000' }, { query: '', page: null }, { query: '', page: -1 }, { query: '', page: 0.5 }, { query: '', page: 50 }, { query: '', registry: 'http://localhost' }]) {
    const result = await invoke(args, fetcher);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'marketplace/invalid-query');
  }
  const mutation = await handleMarketplace('install', { args: { query: '' } }, idle(), { fetch: fetcher });
  assert.equal(mutation.ok, false);
  if (!mutation.ok) assert.equal(mutation.error.code, 'marketplace/not-found');
  const envelope = await handleMarketplace('search', { args: { query: '' }, url: 'http://localhost' }, idle(), { fetch: fetcher });
  assert.equal(envelope.ok, false);
  assert.equal(calls, 0);
});

test('last permitted candidate page cannot advertise an unreachable next page', async () => {
  const result = await invoke({ query: '', page: 49 }, async input => {
    assert.equal(new URL(input).searchParams.get('from'), '588');
    return json({ total: 9999, objects: [] });
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.hasMore, false);
});

test('public source fields exclude executable URLs and embedded credentials', async () => {
  const result = await invoke({ query: '' }, async input => new URL(input).pathname === '/-/v1/search'
    ? json({ total: 1, objects: [candidate()] })
    : json(manifest('dsh-market-test', { homepage: 'javascript:alert(1)', repository: 'https://token:secret@example.test/a', description: 'x'.repeat(4000) })));
  assert.equal(result.ok, true);
  if (result.ok) {
    const item = result.value.items[0];
    assert.equal(item.homepage, undefined); assert.equal(item.repository, undefined);
    assert.equal(item.description.length, 1200);
  }
});

test('malformed or oversized search responses fail without displaying registry response text', async () => {
  const responses = [
    json({ total: 1.5, objects: [] }), json({ total: 1, objects: {} }), json({ total: 13, objects: Array.from({ length: 13 }, () => candidate()) }),
    new Response('not json', { headers: { 'content-type': 'application/json' } }), new Response('<h1>proxy error</h1>'),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }),
    new Response(' '.repeat(1048577), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of responses) {
    const result = await invoke({ query: '' }, async () => response);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, 'marketplace/invalid-response'); assert.doesNotMatch(result.error.message, /proxy error|not json/); }
  }
});

test('registry rate limiting is readable and partial metadata failures do not erase verified results', async () => {
  const limited = await invoke({ query: '' }, async () => new Response('upstream private diagnostic', { status: 429 }));
  assert.equal(limited.ok, false);
  if (!limited.ok) { assert.equal(limited.error.code, 'marketplace/unavailable'); assert.match(limited.error.message, /频率/); }
  const result = await invoke({ query: '' }, async input => {
    const path = new URL(input).pathname;
    if (path === '/-/v1/search') return json({ total: 2, objects: [candidate('good'), candidate('bad')] });
    return path.includes('/good/') ? json(manifest('good')) : new Response('', { status: 503 });
  });
  assert.equal(result.ok, true);
  if (result.ok) { assert.deepEqual(result.value.items.map(item => item.name), ['good']); assert.match(result.value.warning!, /部分/); }
});

test('complete metadata outage is an error rather than an empty catalog', async () => {
  const result = await invoke({ query: '' }, async input => new URL(input).pathname === '/-/v1/search'
    ? json({ total: 1, objects: [candidate()] }) : new Response('', { status: 503 }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'marketplace/unavailable');
});

test('already cancelled and in-flight cancelled searches stop before publishing results', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  let calls = 0;
  const initial = await invoke({ query: '' }, async () => { calls++; return json({}); }, cancelled.signal);
  assert.equal(initial.ok, false); assert.equal(calls, 0);
  if (!initial.ok) assert.equal(initial.error.code, 'marketplace/cancelled');
  const active = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = invoke({ query: '' }, async (_url, init) => {
    entered();
    return new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); });
  }, active.signal);
  await started; active.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'marketplace/cancelled');
});

test('deadline aborts a hung registry fetch and cancels a pending response body', async () => {
  const fetchTimeout = await invoke({ query: '' }, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }), idle(), 10);
  assert.equal(fetchTimeout.ok, false);
  if (!fetchTimeout.ok) assert.equal(fetchTimeout.error.code, 'marketplace/timeout');
  let bodyCancelled = false;
  const bodyTimeout = await invoke({ query: '' }, async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), { headers: { 'content-type': 'application/json' } }), idle(), 10);
  assert.equal(bodyTimeout.ok, false);
  if (!bodyTimeout.ok) assert.equal(bodyTimeout.error.code, 'marketplace/timeout');
  assert.equal(bodyCancelled, true);
});

test('metadata verification has bounded parallel work and preserves npm result order', async () => {
  let active = 0; let peak = 0;
  const names = Array.from({ length: 12 }, (_, index) => `plugin-${index}`);
  const result = await searchMarketplace({ query: '' }, idle(), { fetch: async input => {
    const path = new URL(input).pathname;
    if (path === '/-/v1/search') return json({ total: 12, objects: names.map(name => candidate(name)) });
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return json(manifest(path.split('/')[1]));
  } });
  assert.equal(peak, 4);
  assert.deepEqual(result.items.map(item => item.name), names);
});

test('runtime registration uses the existing authenticated RPC channel and releases it on disposal', async () => {
  let released = false; let dispose!: () => void | Promise<void>; let handler: any;
  apply({
    connection: { rpc: { handle(channel, next) { assert.equal(channel, '/desktop-marketplace'); handler = next; return () => { released = true; }; } } },
    effect(factory) { dispose = factory(); },
  });
  const result = await handler('remove', {}, idle());
  assert.equal(result.ok, false);
  await dispose(); assert.equal(released, true);
});
