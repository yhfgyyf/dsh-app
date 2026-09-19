import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtime = process.env.DSH_OVERLAY_TEST_RUNTIME ?? fileURLToPath(new URL('../.runtime/node_modules', import.meta.url));
const host = (await import(pathToFileURL(join(runtime, '@deepseek-ai/dsh-api-session-controller/lib/typert.host.js')).href)).TYPERT;
const remote = (await import(pathToFileURL(join(runtime, '@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js')).href)).TYPERT_REMOTE;

test('session deletion and MP4 receipts retain the alpha.2 lazy RPC codec contract on every surface', async () => {
  const source = await readFile(join(runtime, '@deepseek-ai/dsh-api-remotes/lib/client.js'), 'utf8');
  let module: { factory: (require: unknown) => { apply: (ctx: unknown) => Promise<unknown> } };
  new Function('window', source)({ __ModuleLoader__: { load: (value: typeof module) => { module = value; } } });
  const contributions: typeof host[] = [];
  await module!.factory(() => { throw new Error('Unexpected browser dependency'); }).apply({ remote: {
    $mount: async (value: typeof host) => { contributions.push(value); return () => {}; },
  } });
  const browser = contributions.find(value => value.package === '@deepseek-ai/dsh-api-session-controller');
  assert.ok(browser, 'The shipped browser must mount the session controller descriptors');
  for (const contract of [host, remote, browser]) {
    const descriptors = contract.invocations ?? contract.descriptors;
    const deletion = descriptors.find((value: { method: string }) => value.method === 'delete');
    assert.ok(deletion);
    assert.equal(typeof deletion.parameters[0].codec.create, 'function');
    assert.equal(typeof deletion.result.create, 'function');
    assert.deepEqual(deletion.parameters[0].codec.create().parse({ sessionId: 'fixture' }), { sessionId: 'fixture' });
    assert.deepEqual(deletion.result.create().parse({ sessionId: 'fixture' }), { sessionId: 'fixture' });
    const attachment = descriptors.find((value: { method: string }) => value.method === 'attachment');
    const video = { attachment: { attachmentId: 'video', mediaType: 'video/mp4', bytes: 32, width: 1, height: 1 }, data: 'AAAA' };
    assert.deepEqual(attachment.result.create().parse(video), video);
    assert.equal(attachment.result.create().safeParse({ ...video, attachment: { ...video.attachment, mediaType: 'video/unknown' } }).success, false);
  }
});
