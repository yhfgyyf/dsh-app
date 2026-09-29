import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { apply } from '../src/runtime/plugin-security-host.ts';
import type { PluginReviewDependencies } from '../src/runtime/plugin-security.ts';

const idle = () => new AbortController().signal;
const pkg = { name: 'dsh-direct-fixture', version: '1.2.3', dsh: { bundle: { patch: './bundle.yml' } } };
const spec = pkg.name + '@' + pkg.version;
function fixture() {
  const buffers: Buffer[] = [];
  for (const [name, text] of Object.entries({ 'package/package.json': JSON.stringify(pkg), 'package/bundle.yml': '- insert: []\n' })) {
    const content = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name); header.write('0000644\0', 100);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write('0', 156);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    buffers.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  const archive = gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const metadata = { ...pkg, dist: {
    tarball: 'https://registry.npmjs.org/dsh-direct-fixture/-/dsh-direct-fixture-1.2.3.tgz',
    integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'),
  } };
  const calls: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
    assert.equal(init.redirect, 'error');
    return url.endsWith('.tgz') ? new Response(new Uint8Array(archive)) : Response.json(metadata);
  };
  return { archive, sha256, metadata, calls, fetch };
}
async function host(t: TestContext, dependencies?: Pick<PluginReviewDependencies, 'llm' | 'agentDefaultModel'>) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-direct-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let handler!: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<any>;
  let modelCalls = 0; let selections = 0;
  apply({
    profileContext: { dir: directory },
    effect(factory) { return factory(); },
    connection: { rpc: { handle(channel, next) { assert.equal(channel, '/desktop-plugin-security'); handler = next; return () => {}; } } },
    agentDefaultModel: { currentSelection() { selections++; throw new Error('No model is configured'); } },
    llm: { async prepareCall() { modelCalls++; throw new Error('Direct installation must not invoke the model'); } },
    ...dependencies,
  });
  return { directory, handler, counts: () => ({ modelCalls, selections }) };
}

test('direct preparation caches the exact verified archive without a model or review receipt', async t => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', f.fetch);
  const h = await host(t);
  const result = await h.handler('prepare-direct-install', { args: { spec } }, idle());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { spec, sha256: f.sha256, installSpec: join(h.directory, 'reviewed-packages', f.sha256 + '.tgz') });
  assert.deepEqual(await readFile(result.value.installSpec), f.archive);
  assert.equal(createHash('sha256').update(await readFile(result.value.installSpec)).digest('hex'), result.value.sha256);
  assert.deepEqual(h.counts(), { modelCalls: 0, selections: 0 });
  assert.equal(f.calls.length, 2);
  const reviewOnly = await h.handler('prepare-install', { args: { reviewId: f.sha256 } }, idle());
  assert.equal(reviewOnly.ok, false, 'A direct archive is not an approved review receipt');
  assert.equal(reviewOnly.error.code, 'plugin-review/expired');

  await chmod(result.value.installSpec, 0o600);
  await writeFile(result.value.installSpec, 'tampered');
  const changed = await h.handler('prepare-direct-install', { args: { spec } }, idle());
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, 'plugin-install/changed');
  assert.match(changed.error.message, /缓存/);
});

test('direct preparation requires a precise public npm version before touching the network', async t => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', f.fetch);
  const h = await host(t);
  for (const invalid of [pkg.name, pkg.name + '@latest', pkg.name + '@^1.2.3', 'file:/tmp/plugin', 'https://example.org/plugin.tgz', 'github:owner/repo', 'x;pwd@1.2.3', spec + '\n', null]) {
    const result = await h.handler('prepare-direct-install', { args: { spec: invalid } }, idle());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'plugin-install/invalid-input');
  }
  assert.equal((await h.handler('prepare-direct-install', { args: { spec, reviewId: 'forged' } }, idle())).ok, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(h.counts(), { modelCalls: 0, selections: 0 });
});

test('direct preparation rejects package source and integrity mismatches without producing install instructions', async t => {
  const f = fixture();
  const h = await host(t);
  for (const changed of ['source', 'integrity', 'identity']) {
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('.tgz')) return changed === 'integrity' ? new Response('tampered') : f.fetch(url, init);
      return Response.json(changed === 'source'
        ? { ...f.metadata, dist: { ...f.metadata.dist, tarball: 'https://elsewhere.example/plugin.tgz' } }
        : changed === 'identity' ? { ...f.metadata, version: '9.9.9' } : f.metadata);
    });
    const result = await h.handler('prepare-direct-install', { args: { spec } }, idle());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'plugin-install/unavailable');
    assert.match(result.error.message, /下载或准备失败/);
    assert.doesNotMatch(result.error.message, /未完成检查|已检查|已审查/);
    assert.equal(result.value, undefined);
  }
  assert.deepEqual(await readdir(h.directory), []);
  assert.deepEqual(h.counts(), { modelCalls: 0, selections: 0 });
});

test('direct preparation enforces the same 256 MiB compressed archive limit before reading bytes', async t => {
  const f = fixture();
  const h = await host(t);
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => url.endsWith('.tgz')
    ? new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(256 * 1024 * 1024 + 1) } })
    : f.fetch(url, init));
  const result = await h.handler('prepare-direct-install', { args: { spec } }, idle());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'plugin-install/unavailable');
  assert.match(result.error.message, /256 MiB 大小上限/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(h.directory), []);
  assert.deepEqual(h.counts(), { modelCalls: 0, selections: 0 });
});

test('aborting a direct package download cancels upstream and cannot return an install archive', { timeout: 5000 }, async t => {
  const f = fixture();
  const h = await host(t);
  const controller = new AbortController();
  let entered!: () => void;
  const downloading = new Promise<void>(resolve => { entered = resolve; });
  let upstreamCancelled = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (!url.endsWith('.tgz')) return f.fetch(url, init);
    entered();
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => { upstreamCancelled = true; reject(init.signal!.reason); }, { once: true }));
  });
  const request = h.handler('prepare-direct-install', { args: { spec } }, controller.signal);
  await downloading;
  controller.abort();
  const result = await request;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'plugin-install/cancelled');
  assert.equal(upstreamCancelled, true);
  assert.deepEqual(await readdir(h.directory), []);
  assert.deepEqual(h.counts(), { modelCalls: 0, selections: 0 });
});

test('direct preparation is independent of an outstanding review while review concurrency stays guarded', { timeout: 5000 }, async t => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', f.fetch);
  let entered!: () => void;
  const reviewing = new Promise<void>(resolve => { entered = resolve; });
  let modelCalls = 0;
  const h = await host(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: { async prepareCall(config, signal) {
      modelCalls++; entered();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
  });
  const reviewController = new AbortController();
  t.after(() => reviewController.abort());
  const review = h.handler('review', { args: { spec } }, reviewController.signal);
  await reviewing;
  const busy = await h.handler('review', { args: { spec } }, idle());
  assert.equal(busy.error.code, 'plugin-review/busy');
  const direct = await h.handler('prepare-direct-install', { args: { spec } }, idle());
  assert.equal(direct.ok, true);
  assert.equal(modelCalls, 1);
  reviewController.abort();
  const afterCancel = h.handler('prepare-direct-install', { args: { spec } }, idle());
  assert.equal((await afterCancel).ok, true);
  assert.equal((await review).value.error.code, 'cancelled');
  assert.equal(modelCalls, 1);
});
