import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeNodeModules = process.env.DSH_OVERLAY_TEST_RUNTIME ?? fileURLToPath(new URL('../.runtime/node_modules', import.meta.url));
const { createUserMessage } = await import(pathToFileURL(join(runtimeNodeModules, '@deepseek-ai/dsh-llm/lib/index.js')).href);
const source = await readFile(join(runtimeNodeModules, 'dsh-progressive-tools/lib/index.js'), 'utf8');
const invokeStart = source.indexOf('const invokeTool = defineTool({');
const executeStart = source.indexOf('async execute(args, exec) {', invokeStart);
const executeEnd = source.indexOf('\n\t\tpresentCall:', executeStart);
assert.ok(invokeStart >= 0 && executeStart > invokeStart && executeEnd > executeStart);
const createExecute = new Function('ctx', 'createUserMessage', 'catalog', 'graphemes', `
  const resolved = { maxToolNameChars: 128 }, omitted = [];
  return ({ ${source.slice(executeStart, executeEnd)} }).execute;
`);

async function invoke(result: any) {
  const deferred: any[] = [];
  let concluded = false;
  const execute = createExecute({ tools: { execute: async () => result } }, createUserMessage, () => [{ name: 'capture' }], Array.from);
  const value = execute({ name: 'capture', arguments: {} }, {
    callId: 'image-test', rootCallId: 'image-test',
    deferContext: (message: any) => deferred.push(message),
    concludeTurn: () => { concluded = true; },
  });
  return { value, deferred, concluded: () => concluded };
}

test('progressive invoke forwards successful images into immutable user context before additional contexts', async () => {
  const content = [{ type: 'text', text: 'Screenshot' }, { type: 'image', attachment: { attachmentId: 'image-test', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }];
  const extra = createUserMessage({ content: [{ type: 'text', text: 'Details' }], source: { kind: 'plugin', plugin: 'capture' } });
  const run = await invoke({ content, additionalContexts: [extra], value: { captured: true }, concludesTurn: true });
  assert.deepEqual(await run.value, { captured: true });
  assert.equal(run.concluded(), true);
  assert.equal(run.deferred.length, 2);
  const message = run.deferred[0];
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.deepEqual(message.source, { kind: 'plugin', plugin: 'dsh-progressive-tools' });
  assert.deepEqual(message.content, content);
  assert.notEqual(message.content, content);
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content));
  assert.equal(run.deferred[1], extra);
});

test('progressive invoke keeps text-only results unchanged and does not forward failed images', async () => {
  const text = await invoke({ content: [{ type: 'text', text: 'Done' }], value: 7 });
  assert.equal(await text.value, 7);
  assert.deepEqual(text.deferred, []);
  const extra = createUserMessage({ content: [{ type: 'text', text: 'Error context' }], source: { kind: 'plugin', plugin: 'capture' } });
  const failed = await invoke({ content: [{ type: 'image', attachment: { attachmentId: 'image-test', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }], isError: true, error: { message: 'Capture failed' }, additionalContexts: [extra] });
  await assert.rejects(failed.value, /Capture failed/);
  assert.deepEqual(failed.deferred, [extra]);
});

test('progressive image installer verifies its first install, backup, idempotence and unknown-edit refusal', async () => {
  const { applyProgressiveImages } = await import(new URL('../scripts/install-progressive-images.mjs', import.meta.url).href);
  const pin = JSON.parse(await readFile(new URL('../patches/progressive-images/manifest.json', import.meta.url), 'utf8'));
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  assert.equal(sha(source), pin.after);
  const before = source.replace('import { createUserMessage } from "@deepseek-ai/dsh-llm";\n', '').replace('\t\t\tif (!result.isError && result.content.some(block => block.type === "image")) exec.deferContext(createUserMessage({ content: result.content, source: { kind: "plugin", plugin: "dsh-progressive-tools" } }));\n', '');
  assert.equal(sha(before), pin.before);
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-progressive-images-'));
  const target = join(scratch, pin.package, pin.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(join(scratch, pin.package, 'package.json'), JSON.stringify({ name: pin.package, version: pin.version }));
  await writeFile(target, before);
  const options = { runtimeNodeModules: scratch, backupHome: join(scratch, 'backup') };
  assert.deepEqual(await applyProgressiveImages({ ...options, mode: 'check' }), { pending: 1 });
  await assert.rejects(applyProgressiveImages({ ...options, mode: 'verify' }), /patch is missing/);
  const applied = await applyProgressiveImages(options);
  assert.equal(applied.changed, true);
  assert.equal(sha(await readFile(join(applied.backup, 'index.js'))), pin.before);
  assert.equal(sha(await readFile(target)), pin.after);
  assert.deepEqual(await applyProgressiveImages(options), { changed: false });
  assert.deepEqual(await applyProgressiveImages({ ...options, mode: 'check' }), { pending: 0 });
  assert.deepEqual(await applyProgressiveImages({ ...options, mode: 'verify' }), { changed: false });
  const unknown = before + '\n// Local edit\n';
  await writeFile(target, unknown);
  await assert.rejects(applyProgressiveImages(options), /Unrecognized progressive-tools changes preserved/);
  assert.equal(await readFile(target, 'utf8'), unknown);
});
