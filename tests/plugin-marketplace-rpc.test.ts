import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { apply, inject } from '../src/runtime/plugin-marketplace.ts';

const runtimeRequire = createRequire(new URL('../.runtime/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href);
const { HostConnectionService } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-client-connection')).href);
const clientSource = await readFile(runtimeRequire.resolve('@deepseek-ai/dsh-client-connection/client'), 'utf8');

test('marketplace uses the installed alpha2 client and host RPC contracts, authentication and cancellation', { timeout: 10000 }, async t => {
  const networkFetch = globalThis.fetch;
  const routes: any[] = [];
  const ctx = new Context();
  ctx.provide('webServer', { register(route: any) {
    routes.push(route);
    return () => { routes.splice(routes.indexOf(route), 1); };
  } });
  const host = ctx.plugin((owner: any) => { new HostConnectionService(owner, [], {
    isAuthenticated: (request: any) => request.headers.cookie === 'market-test=allowed',
  }); });
  await host.await();
  const marketplace = ctx.plugin({ name: 'test-marketplace', inject, apply });
  await marketplace.await();
  assert.deepEqual(routes.map(route => route.path), ['/desktop-marketplace']);
  const server = createServer((request, response) => {
    const route = routes.find(route => request.url?.startsWith(route.path + '/'));
    if (!route) { response.writeHead(404).end(); return; }
    void route.handler(request, response).catch((error: Error) => { response.writeHead(500).end(error.message); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let plugin: any;
  runInNewContext(clientSource, { URL, crypto: globalThis.crypto, console, location: { origin },
    window: { __ModuleLoader__: { load(entry: any) { plugin = entry.factory(() => { throw new Error('Unexpected client dependency'); }); } } },
  });
  let client: any;
  const sent: { url: string; envelope: any; signal?: AbortSignal }[] = [];
  plugin.installConnection({ provide(_name: string, service: any) { client = service; } }, { transport: {
    fetch(input: URL, init: RequestInit) {
      sent.push({ url: input.href, envelope: JSON.parse(String(init.body)), signal: init.signal ?? undefined });
      return networkFetch(input, { ...init, headers: { ...init.headers, cookie: 'market-test=allowed' } });
    },
  } });
  let registryCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    registryCalls++;
    assert.equal(new URL(input).origin, 'https://registry.npmjs.org');
    return Response.json({ total: 0, objects: [] });
  });
  try {
    const signal = new AbortController().signal;
    const result = await client.rpc.call('/desktop-marketplace', 'search', { args: { query: 'memory', page: 0 } }, signal);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.items, []);
    assert.equal(sent[0].url, origin + '/desktop-marketplace/search');
    assert.equal(sent[0].signal, signal);
    assert.deepEqual(sent[0].envelope.payload, { args: { query: 'memory', page: 0 } });
    const unauthenticated = await networkFetch(origin + '/desktop-marketplace/search', { method: 'POST' });
    assert.equal(unauthenticated.status, 401);
    const foreignOrigin = await networkFetch(origin + '/desktop-marketplace/search', { method: 'POST', headers: { cookie: 'market-test=allowed', origin: 'https://other.example' } });
    assert.equal(foreignOrigin.status, 403);
    assert.equal(registryCalls, 1, 'Rejected requests never reach npm');
    const malformed = await client.rpc.call('/desktop-marketplace', 'search', { query: 'missing args' });
    assert.equal(malformed.error.code, 'marketplace/invalid-query');
    const mismatch = await networkFetch(origin + '/desktop-marketplace/search', { method: 'POST', headers: { cookie: 'market-test=allowed', 'content-type': 'application/json' }, body: JSON.stringify({ ...sent[0].envelope, method: 'remove' }) });
    assert.equal((await mismatch.json()).result.error.code, 'gateway/bad-request');
    let entered!: () => void; let cancelled!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const upstreamCancelled = new Promise<void>(resolve => { cancelled = resolve; });
    t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
      entered();
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => { cancelled(); reject(init.signal!.reason); }, { once: true }));
    });
    const abort = new AbortController();
    const request = client.rpc.call('/desktop-marketplace', 'search', { args: { query: 'cancel' } }, abort.signal);
    await pending;
    abort.abort();
    await assert.rejects(request, /abort/i);
    await upstreamCancelled;
    await marketplace.dispose();
    assert.equal(routes.length, 0);
  } finally {
    await marketplace.dispose();
    await host.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
