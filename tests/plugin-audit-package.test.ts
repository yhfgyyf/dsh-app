import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectNpmPackage, readNpmArchive } from '../src/runtime/plugin-audit-package.ts';
import { apply as applySecurityHost } from '../src/runtime/plugin-security-host.ts';

const idle = () => new AbortController().signal;
function tar(entries: { name: string; content?: string | Buffer; type?: string }[]): Buffer {
  const buffers: Buffer[] = [];
  for (const item of entries) {
    const content = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content ?? '');
    const header = Buffer.alloc(512);
    header.write(item.name); header.write('0000644\0', 100);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write(item.type ?? '0', 156);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    buffers.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
}
const pkg = { name: 'dsh-review-fixture', version: '1.2.3', scripts: { postinstall: 'node install.js' }, dependencies: { example: '^1.0.0' }, dsh: { bundle: { patch: './bundle.yml' } } };
function fixture(override: { manifest?: object; archive?: Buffer; metadata?: Record<string, unknown> } = {}) {
  const archive = override.archive ?? tar([
    { name: 'package/package.json', content: JSON.stringify(override.manifest ?? pkg) },
    { name: 'package/bundle.yml', content: '- insert:\n    - name: ./index.js\n' },
    { name: 'package/index.js', content: 'export function apply() {}\n' },
    { name: 'package/install.js', content: 'throw new Error("never execute this audit fixture");\n' },
  ]);
  const metadata = { ...pkg, dist: { tarball: 'https://registry.npmjs.org/dsh-review-fixture/-/dsh-review-fixture-1.2.3.tgz', integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') }, ...override.metadata };
  const calls: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    return new Response(url.endsWith('.tgz') ? new Uint8Array(archive) : JSON.stringify(metadata));
  };
  return { archive, metadata, calls, fetch };
}
const MiB = 1024 * 1024;
let largeArchive: Buffer | undefined;
function largeFixture() {
  largeArchive ??= tar([
    { name: 'package/package.json', content: JSON.stringify(pkg) },
    { name: 'package/bundle.yml', content: '- insert:\n    - name: ./index.js\n' },
    { name: 'package/index.js', content: 'export function apply() {}\n' },
    { name: 'package/install.js', content: 'throw new Error("never execute this audit fixture");\n' },
    { name: 'package/assets/random.bin', content: randomBytes(11 * MiB) },
    { name: 'package/assets/padding.bin', content: Buffer.alloc(23 * MiB) },
  ]);
  assert.ok(largeArchive.length > 10 * MiB && largeArchive.length < 64 * MiB);
  return fixture({ archive: largeArchive });
}
async function archiveFailure(response: Response): Promise<string> {
  const f = fixture();
  let message = '';
  await assert.rejects(inspectNpmPackage(pkg.name, idle(), {
    fetch: async (url, init) => url.endsWith('.tgz') ? response : f.fetch(url, init),
  }), (error: Error) => { message = error.message; return true; });
  return message;
}
test('large plugin assets pass archive limits without expanding model review material', async () => {
  const f = largeFixture();
  const result = await inspectNpmPackage(pkg.name, idle(), { fetch: f.fetch });
  assert.equal(result.scope.archiveBytes, f.archive.length);
  assert.ok(result.scope.expandedBytes > 32 * MiB && result.scope.expandedBytes < 256 * MiB);
  assert.equal(result.scope.filesTotal, 6);
  assert.equal(result.scope.filesReviewed, 4);
  assert.ok(result.scope.bytesReviewed <= 128 * 1024);
  assert.equal(result.scope.omittedFiles, 2);
  assert.equal(result.scope.truncated, true);
  assert.ok(result.limitations.some(text => text.includes('省略 2 个文件')));
  assert.equal(result.files[0].path, 'package.json');
  assert.equal(result.files[1].path, 'bundle.yml');
  assert.ok(result.files.some(file => file.path === 'install.js' && file.content.includes('never execute')));
  assert.equal(result.sha256, createHash('sha256').update(f.archive).digest('hex'));
});
test('advertised archive sizes above 64 MiB and up to 256 MiB pass the download size check', async () => {
  for (const contentLength of [64 * MiB + 1, 256 * MiB]) {
    const f = fixture();
    const result = await inspectNpmPackage(pkg.name, idle(), {
      fetch: async (url, init) => url.endsWith('.tgz')
        ? new Response(new Uint8Array(f.archive), { headers: { 'content-length': String(contentLength) } })
        : f.fetch(url, init),
    });
    assert.equal(result.scope.archiveBytes, f.archive.length);
    assert.equal(result.sha256, createHash('sha256').update(f.archive).digest('hex'));
  }
});
test('an advertised archive larger than 256 MiB is rejected before reading its body', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const message = await archiveFailure(new Response(body, { headers: { 'content-length': String(256 * MiB + 1) } }));
  assert.match(message, /安装包/);
  assert.match(message, /256 MiB/);
  assert.equal(cancelled, true);
});
test('missing or understated content-length cannot bypass the 256 MiB streaming limit', async () => {
  for (const contentLength of [undefined, '1']) {
    let sent = 0; let cancelled = false;
    const chunk = new Uint8Array(MiB);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Leave unread chunks beyond the limit so cancellation remains observable.
        if (sent >= 260 * MiB) { controller.close(); return; }
        controller.enqueue(chunk); sent += chunk.byteLength;
      },
      cancel() { cancelled = true; },
    });
    const message = await archiveFailure(new Response(body, { headers: contentLength === undefined ? {} : { 'content-length': contentLength } }));
    assert.match(message, /安装包/);
    assert.match(message, /256 MiB/);
    assert.ok(sent > 256 * MiB && sent < 260 * MiB);
    assert.equal(cancelled, true);
  }
});
test('npm metadata retains its separate 1 MiB limit', async () => {
  await assert.rejects(inspectNpmPackage(pkg.name, idle(), {
    fetch: async () => new Response('{}', { headers: { 'content-length': String(MiB + 1) } }),
  }), (error: Error) => /npm/.test(error.message) && /1 MiB/.test(error.message));
});
test('HTTP and empty response errors remain distinct from archive size errors', async () => {
  const httpMessage = await archiveFailure(new Response('unavailable', { status: 503 }));
  const emptyMessage = await archiveFailure(new Response(null));
  const sizeMessage = await archiveFailure(new Response('x', { headers: { 'content-length': String(256 * MiB + 1) } }));
  assert.match(httpMessage, /503/);
  assert.doesNotMatch(httpMessage, /大小限制|检查上限/);
  assert.match(emptyMessage, /空|响应体/);
  assert.notEqual(emptyMessage, httpMessage);
  assert.notEqual(emptyMessage, sizeMessage);
});
test('expanded archives still stop at 256 MiB even when compressed bytes are small', () => {
  // Concatenated gzip members avoid allocating a 257 MiB source fixture.
  const member = gzipSync(Buffer.alloc(MiB));
  const archive = Buffer.concat(Array.from({ length: 257 }, () => member));
  assert.ok(archive.length < MiB);
  assert.throws(() => readNpmArchive(archive), /256 MiB/);
});
test('the exact npm archive is verified and inspected in memory, including scripts without executing them', async () => {
  const f = fixture();
  const result = await inspectNpmPackage(pkg.name, idle(), { fetch: f.fetch });
  assert.equal(result.spec, pkg.name + '@1.2.3');
  assert.deepEqual(result.facts.scripts, pkg.scripts);
  assert.deepEqual(result.facts.dependencies, pkg.dependencies);
  assert.equal(result.sha256, createHash('sha256').update(f.archive).digest('hex'));
  assert.equal(result.scope.filesReviewed, 4);
  assert.ok(result.files.some(file => file.path === 'install.js' && file.content.includes('never execute')));
  assert.equal(f.calls.length, 2);
});
test('Git, file URLs and command-like input never reach the network or a package runner', async () => {
  for (const spec of ['file:/tmp/plugin', 'https://example.org/plugin.tgz', 'github:owner/repo', 'x@^1.0.0', 'x;pwd', '../x', 'x@latest\n']) {
    if (spec.endsWith('\n')) continue; // Outer whitespace is normalized like the official dialog.
    const f = fixture();
    await assert.rejects(inspectNpmPackage(spec, idle(), { fetch: f.fetch }));
    assert.equal(f.calls.length, 0);
  }
});
test('archive integrity, registry identity and package identity mismatches stop review', async () => {
  const invalid = [
    fixture({ metadata: { name: 'different' } }),
    fixture({ metadata: { version: '2.0.0' } }),
    fixture({ metadata: { dist: { tarball: 'https://elsewhere.example/x.tgz', integrity: 'sha512-' + Buffer.alloc(64).toString('base64') } } }),
    fixture({ manifest: { ...pkg, name: 'different' } }),
  ];
  for (const f of invalid) await assert.rejects(inspectNpmPackage(pkg.name + '@1.2.3', idle(), { fetch: f.fetch }));
  const f = fixture();
  const changed = async (url: string, init: RequestInit) => url.endsWith('.tgz') ? new Response(Buffer.from('changed')) : f.fetch(url, init);
  await assert.rejects(inspectNpmPackage(pkg.name, idle(), { fetch: changed }), /摘要校验失败/);
});
test('tar traversal, duplicate paths, links, unsupported extensions and broken headers are refused', () => {
  for (const entries of [
    [{ name: 'package/../../outside' }], [{ name: 'outside' }], [{ name: 'package/a\\b' }],
    [{ name: 'package/a', type: '2' }], [{ name: 'package/a', type: '1' }],
    [{ name: 'package/a' }, { name: 'package/a' }], [{ name: 'package/a', type: 'S' }],
  ]) assert.throws(() => readNpmArchive(tar(entries)));
  assert.throws(() => readNpmArchive(gzipSync(Buffer.alloc(512, 1))), /tar/);
});
test('review material truncation is explicit and preserves the package and bundle first', async () => {
  const archive = tar([
    { name: 'package/package.json', content: JSON.stringify(pkg) },
    { name: 'package/bundle.yml', content: '- insert: []\n' },
    ...Array.from({ length: 35 }, (_, index) => ({ name: `package/file${index}.js`, content: '// '.repeat(10000) })),
  ]);
  const f = fixture({ archive });
  const result = await inspectNpmPackage(pkg.name, idle(), { fetch: f.fetch });
  assert.equal(result.files[0].path, 'package.json');
  assert.equal(result.files[1].path, 'bundle.yml');
  assert.ok(result.scope.bytesReviewed <= 128 * 1024);
  assert.equal(result.scope.truncated, true);
  assert.ok(result.scope.omittedFiles > 0);
  assert.ok(result.limitations.some(text => text.includes('截断')));
});

test('only a completed DSH report can prepare the same large hashed archive for official installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-review-artifact-'));
  const f = largeFixture(); const originalFetch = globalThis.fetch;
  let handler: any; let models = 0;
  globalThis.fetch = f.fetch as typeof fetch;
  const answer = JSON.stringify({ summary: '仅为测试报告。', risk: 'low', findings: [], limitations: [] });
  applySecurityHost({
    profileContext: { dir: directory },
    effect(factory) { return factory(); },
    connection: { rpc: { handle(channel, next) { assert.equal(channel, '/desktop-plugin-security'); handler = next; return () => {}; } } },
    agentDefaultModel: { currentSelection() { return { provider: 'fixture', model: 'fixture' }; } },
    llm: { async prepareCall(config) { models++; return { config, async *stream() {
      yield { type: 'text-delta', index: 0, text: answer }; yield { type: 'finish', reason: { kind: 'stop' } };
    } }; } },
  });
  try {
    assert.equal((await handler('prepare-install', { args: { reviewId: 'forged' } }, idle())).ok, false);
    assert.equal(models, 0);
    const result = await handler('review', { args: { spec: pkg.name + '@1.2.3' } }, idle());
    assert.equal(result.ok, true); assert.equal(result.value.status, 'complete');
    assert.ok(result.value.reviewId);
    assert.equal(models, 1);
    assert.ok(result.value.scope.archiveBytes > 10 * MiB);
    const prepared = await handler('prepare-install', { args: { reviewId: result.value.reviewId } }, idle());
    assert.equal(prepared.ok, true);
    assert.equal(prepared.value.spec, pkg.name + '@1.2.3');
    assert.equal(prepared.value.sha256, result.value.sha256);
    assert.deepEqual(await readFile(prepared.value.installSpec), f.archive);
    assert.ok(prepared.value.installSpec.startsWith(join(directory, 'reviewed-packages')));
    await chmod(prepared.value.installSpec, 0o600);
    await writeFile(prepared.value.installSpec, 'tampered');
    assert.equal((await handler('prepare-install', { args: { reviewId: result.value.reviewId } }, idle())).ok, false);
    const clock = Date.now;
    try {
      Date.now = () => clock() + 600001;
      const expired = await handler('prepare-install', { args: { reviewId: result.value.reviewId } }, idle());
      assert.equal(expired.error.code, 'plugin-review/expired');
    } finally { Date.now = clock; }
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});
