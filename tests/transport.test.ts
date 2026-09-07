import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshTransport } from '../src/main/transport.ts';
const endpoint = 'http://127.0.0.1:39001';
const own = '<!doctype html><html><div id="root"></div><script src="/own-entry.js"></script></html>';
const assets = new Map([['app/index.html', own], ['plugin.js', 'desktop plugin']]);
const getAsset = async (name: string) => assets.has(name) ? { body: new TextEncoder().encode(assets.get(name)!), contentType: name.endsWith('.html') ? 'text/html' : 'text/javascript' } : undefined;

test('desktop document is available even when no Web App homepage exists', async () => {
  const handle = createDshTransport({ getEndpoint: () => endpoint, getAsset, fetch: async () => { throw new Error('No Web App'); } });
  assert.equal(await (await handle(new Request(endpoint))).text(), own);
  assert.equal(await (await handle(new Request(endpoint, { method: 'HEAD' }))).text(), '');
  assert.equal((await handle(new Request(endpoint, { method: 'POST' }))).status, 405);
});

test('RPC and event streams retain request, response and cancellation identity', async () => {
  const abort = new AbortController();
  const request = new Request(endpoint + '/api/session.prompt', { method: 'POST', body: '{"text":"你好"}', signal: abort.signal });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
  const handle = createDshTransport({ getEndpoint: () => endpoint, getAsset, fetch: async value => { assert.equal(value, request); return upstream; } });
  const response = await handle(request);
  assert.equal(response, upstream);
  const reader = response.body!.getReader();
  controller.enqueue(new TextEncoder().encode('data: first\n\n'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  controller.close();
  abort.abort(); assert.equal(request.signal.aborted, true);
});

test('desktop resources are restricted to the owned origin and exact asset map', async () => {
  const handle = createDshTransport({ getEndpoint: () => endpoint, getAsset, fetch: async () => new Response('network') });
  assert.equal(await (await handle(new Request(endpoint + '/__dsh_desktop__/plugin.js'))).text(), 'desktop plugin');
  assert.equal((await handle(new Request(endpoint + '/__dsh_desktop__/secret'))).status, 404);
  assert.equal(await (await handle(new Request('http://localhost:39001/__dsh_desktop__/plugin.js'))).text(), 'network');
  assert.equal(await (await handle(new Request(endpoint + '/api/download'))).text(), 'network');
});
