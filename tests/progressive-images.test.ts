import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modules = process.env.DSH_OVERLAY_TEST_RUNTIME ?? fileURLToPath(new URL('../.runtime/node_modules', import.meta.url));
const requireRuntime = createRequire(join(modules, '../package.json'));
const load = (name: string) => import(pathToFileURL(requireRuntime.resolve(name)).href);
const [{ Context }, { default: LlmRuntime, ToolCallId, createUserMessage }, { default: ToolRuntime, defineTool }, { default: SystemPrompt }, plugin] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-system-prompt'), load('dsh-progressive-tools'),
]);

async function fixture(t: any, failed = false) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  const content = [{ type: 'text', text: 'Screenshot' }, { type: 'image', attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }];
  const value = { content: [{ type: 'image', mimeType: 'image/png', data: 'FIXTURE_BASE64_MUST_NOT_BE_TEXT' }], structuredContent: { captured: true } };
  const extra = createUserMessage({ content: [{ type: 'text', text: 'Details' }], source: { kind: 'plugin', plugin: 'capture' } });
  ctx.tools.register(defineTool({
    name: 'capture', description: 'Synthetic MCP image fixture.', parameters: {},
    output: { schema: { type: 'json' }, render: () => content },
    execute: async (_args: any, exec: any) => {
      exec.deferContext(extra);
      if (failed) throw new Error('Capture failed');
      exec.concludeTurn();
      return value;
    },
  }));
  await ctx.plugin(plugin, {});
  const result = await ctx.tools.execute({ callId: ToolCallId('image-test'), name: 'invoke_tool', arguments: { name: 'capture', arguments: {} }, signal: new AbortController().signal });
  return { result, value, content, extra };
}

test('built plugin forwards canonical image content once and preserves structured value and lifecycle', async t => {
  const { result, value, content, extra } = await fixture(t);
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, value);
  assert.deepEqual(result.content, content);
  assert.equal(result.content.filter((block: any) => block.type === 'image').length, 1);
  assert.ok(!JSON.stringify(result.content).includes('FIXTURE_BASE64_MUST_NOT_BE_TEXT'));
  assert.equal(result.concludesTurn, true);
  assert.deepEqual(result.additionalContexts, [extra]);
});

test('built plugin preserves errors and error contexts without forwarding images', async t => {
  const { result, extra } = await fixture(t, true);
  assert.equal(result.isError, true);
  assert.match(result.error.message, /Capture failed/);
  assert.ok(result.content.every((block: any) => block.type !== 'image'));
  assert.deepEqual(result.additionalContexts, [extra]);
});

test('integrated image verifier is idempotent and preserves unrecognized bytes', async () => {
  const { applyProgressiveImages } = await import(new URL('../scripts/install-progressive-images.mjs', import.meta.url).href);
  const pin = JSON.parse(await readFile(new URL('../patches/progressive-images/manifest.json', import.meta.url), 'utf8'));
  const source = await readFile(join(modules, pin.package, pin.path), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), pin.sha256);
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-progressive-images-'));
  const target = join(scratch, pin.package, pin.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(join(scratch, pin.package, 'package.json'), JSON.stringify({ name: pin.package, version: pin.version }));
  await writeFile(target, source);
  const options = { runtimeNodeModules: scratch };
  assert.deepEqual(await applyProgressiveImages({ ...options, mode: 'check' }), { pending: 0 });
  assert.deepEqual(await applyProgressiveImages(options), { changed: false });
  assert.deepEqual(await applyProgressiveImages({ ...options, mode: 'verify' }), { changed: false });
  assert.equal(await readFile(target, 'utf8'), source);
  const unknown = source + '\n// Local edit\n';
  await writeFile(target, unknown);
  await assert.rejects(applyProgressiveImages(options), /Unrecognized progressive-tools changes preserved/);
  assert.equal(await readFile(target, 'utf8'), unknown);
});
