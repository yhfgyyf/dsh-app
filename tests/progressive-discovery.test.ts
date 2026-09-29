import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modules = process.env.DSH_OVERLAY_TEST_RUNTIME ?? fileURLToPath(new URL('../.runtime/node_modules', import.meta.url));
const requireRuntime = createRequire(join(modules, '../package.json'));
const load = (name: string) => import(pathToFileURL(requireRuntime.resolve(name)).href);
const [{ Context }, { default: LlmRuntime, ToolCallId }, { default: ToolRuntime, defineTool }, { default: SystemPrompt }, plugin] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-system-prompt'), load('dsh-progressive-tools'),
]);

async function fixture(t: any) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  const names = ['fixture_alpha', 'fixture_beta', 'fixture_delta', 'fixture_gamma', 'fixture_omega'];
  for (const name of names) ctx.tools.register(defineTool({
    name, description: 'Synthetic discovery fixture.',
    parameters: { value: { type: 'string', description: 'Fixture input.' } },
    output: { schema: { type: 'json' }, render: () => [] },
    execute: async () => { throw new Error('Discovery must not execute a business tool'); },
  }));
  await ctx.plugin(plugin, { maxSearchResults: 2 });
  let call = 0;
  const search = (args: { query?: string; limit?: number; cursor?: string }) => ctx.tools.execute({
    callId: ToolCallId('discovery-test-' + ++call), name: 'search_tools', arguments: args,
    signal: new AbortController().signal,
  });
  const page = async (args: { query?: string; limit?: number; cursor?: string }) => {
    const result = await search(args);
    assert.equal(result.isError, false, result.error?.message);
    return result.value;
  };
  return { ctx, names, search, page };
}

test('built plugin bounds default search and pages the wildcard catalog without duplicates', async t => {
  const { names, page } = await fixture(t);
  const initial = await page({});
  assert.equal(initial.total, names.length);
  assert.equal(initial.matches.length, 2);
  assert.equal(initial.truncated, true);
  assert.equal(typeof initial.next_cursor, 'string');
  assert.equal((await page({ query: '*', limit: 99 })).matches.length, 2);

  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await page({ query: '*', limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(result.total, names.length);
    assert.ok(result.matches.length > 0 && result.matches.length <= 2);
    assert.equal(result.truncated, result.next_cursor !== undefined);
    found.push(...result.matches.map((match: any) => match.name));
    assert.ok(found.length <= names.length, 'Pagination must terminate');
    cursor = result.next_cursor;
  } while (cursor !== undefined);
  assert.deepEqual(found, names);
  assert.equal(new Set(found).size, names.length);
});

test('built plugin returns an empty page for an unmatched query', async t => {
  const { page } = await fixture(t);
  const result = await page({ query: 'zzzz_nonexistent_capability_9274' });
  assert.equal(result.total, 0);
  assert.deepEqual(result.matches, []);
  assert.equal(result.truncated, false);
  assert.equal(result.next_cursor, undefined);
  assert.match(result.instructions, /No tools matched/);
});

test('built plugin rejects invalid and schema-stale cursors with restart guidance', async t => {
  const { ctx, page, search } = await fixture(t);
  const initial = await page({ query: '*' });
  assert.equal(typeof initial.next_cursor, 'string');
  for (const cursor of ['not-a-cursor', initial.next_cursor + 'x']) {
    const result = await search({ query: '*', cursor });
    assert.equal(result.isError, true);
    assert.match(result.error.message, /cursor.*restart/i);
  }
  ctx.tools.get('fixture_alpha').parameters.description = 'Updated schema generation';
  const stale = await search({ query: '*', cursor: initial.next_cursor });
  assert.equal(stale.isError, true);
  assert.match(stale.error.message, /cursor.*restart/i);
  const fresh = await page({ query: '*' });
  assert.notEqual(fresh.next_cursor, initial.next_cursor);
  assert.equal((await page({ query: '*', cursor: fresh.next_cursor })).matches.length, 2);
});
