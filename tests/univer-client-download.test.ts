import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { clientUrl, downloadClient } = createRequire(import.meta.url)('./fixtures/univer-client-download.cjs');

test('Univer CDN preparation recovers from HTTP 500 using the same pinned URL', async () => {
  let calls = 0, cancelled = false;
  const bytes = await downloadClient(async (url: string, options: RequestInit) => {
    assert.equal(url, clientUrl); assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (++calls === 1) return { status: 500, body: { cancel: async () => { cancelled = true; } } };
    return new Response('pinned client fixture');
  });
  assert.equal(calls, 2); assert.equal(cancelled, true);
  assert.equal(bytes.toString(), 'pinned client fixture');
});

test('Univer CDN preparation preserves permanent HTTP failures without retry', async () => {
  let calls = 0;
  await assert.rejects(downloadClient(async () => { calls++; return new Response('', { status: 404 }); }), /failed: 404/);
  assert.equal(calls, 1);
});

test('Univer CDN preparation stops after three transient failures', async () => {
  let calls = 0;
  await assert.rejects(downloadClient(async () => { calls++; throw new TypeError('fetch failed'); }), /fetch failed/);
  assert.equal(calls, 3);
});
