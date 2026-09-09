import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireRuntime = createRequire(new URL('../.runtime/package.json', import.meta.url));
const load = (name: string) => import(pathToFileURL(requireRuntime.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { createSystemMessage, createUserMessage } = await load('@deepseek-ai/dsh-llm');
const { default: SessionStore, SessionId } = await load('@deepseek-ai/dsh-session');
const { HostConnectionService } = await load('@deepseek-ai/dsh-client-connection');

test('released system-prompt projection preserves the historical prefix only for a capable continuing route', async () => {
  const source = await readFile(requireRuntime.resolve('@deepseek-ai/dsh-agent-loop'), 'utf8');
  const start = source.indexOf('const SOURCE = "@deepseek-ai/dsh-system-prompt";');
  const end = source.indexOf('/** Tracks the last retained runtime-context snapshot', start);
  assert.ok(start >= 0 && end > start);
  // Run the released implementation against its actual Session store.
  const Projection = new Function('createSystemMessage', source.slice(start, end) + '\nreturn SystemPromptProjection;')(createSystemMessage);
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  try {
    const session = ctx.sessions.create(SessionId('upgrade-prompt-test'));
    const projection = new Projection(session);
    const continuing = { inHistory: true, startsSeries: false };
    const commit = (text: string, input = continuing) => {
      const operations = projection.project(text, input);
      for (const operation of operations) session.append('system/message', { turn: 1, step: 1, message: operation.message }, operation.intent);
      return operations;
    };
    commit('old complete prompt');
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const prefix = JSON.stringify(session.deriveMessages());
    assert.equal(commit('new complete prompt')[0].intent.surfaceOp, 'append');
    assert.equal(JSON.stringify(session.deriveMessages().slice(0, 2)), prefix);
    assert.deepEqual(session.deriveMessages().map((m: { role: string }) => m.role), ['system', 'user', 'system']);
    assert.deepEqual(commit('new complete prompt'), []);
    commit('new complete prompt', { inHistory: true, startsSeries: true });
    assert.deepEqual(session.deriveMessages().map((m: { role: string }) => m.role), ['system', 'user']);
    assert.equal(session.deriveMessages()[0].content[0].text, 'new complete prompt');
    commit('next prompt');
    commit('leading only', { inHistory: false, startsSeries: false });
    assert.deepEqual(session.deriveMessages().map((m: { role: string }) => m.role), ['system', 'user']);
    assert.equal(session.deriveMessages()[0].content[0].text, 'leading only');
    commit('');
    assert.deepEqual(session.deriveMessages().map((m: { role: string }) => m.role), ['user']);
    assert.deepEqual(commit(''), []);
  } finally { await ctx.fiber.dispose(); }
});

test('RPC channels survive late HTTP-server activation and release their routes on disposal', async () => {
  const ctx = new Context();
  const routes = new Map<string, object>();
  let release: () => Promise<void>;
  const serverPlugin = (inner: typeof ctx) => inner.provide('webServer', {
    register(route: { path: string }) {
      assert.equal(routes.has(route.path), false);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  });
  try {
    await ctx.plugin((inner: typeof ctx) => { new HostConnectionService(inner, [], {}); });
    await ctx.plugin({ inject: ['connection'], apply(inner: typeof ctx) {
      release = inner.connection.rpc.handle('/upgrade-test', async () => ({ ok: true, value: true }));
    } });
    assert.equal(routes.size, 0);
    const firstServer = await ctx.plugin(serverPlugin);
    await ctx.fiber.await(); assert.equal(routes.size, 1);
    await firstServer.dispose(); assert.equal(routes.size, 0);
    const secondServer = await ctx.plugin(serverPlugin);
    await ctx.fiber.await(); assert.equal(routes.size, 1);
    await release!(); assert.equal(routes.size, 0);
    await secondServer.dispose();
  } finally { await ctx.fiber.dispose(); }
});
