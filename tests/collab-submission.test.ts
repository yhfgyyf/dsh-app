import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedGeneratedFile, readSubmission } from '../src/runtime/collab-submission.ts';

test('generated attachments are explicit, bounded, inside the run, and unchanged since preview', async () => {
  const home = await mkdtemp(join(tmpdir(), 'collab-submission-')), cwd = join(home, 'run');
  await mkdir(cwd); await writeFile(join(cwd, 'answer.txt'), 'the generated answer'); await writeFile(join(home, 'private.txt'), 'outside fixture');
  const manifest = async (files: string[]) => writeFile(join(cwd, 'submission.json'), JSON.stringify({ body: '# Result\n\n```js\n42\n```', verification: 'fixture only', limitations: '', files }));
  try {
    await manifest(['answer.txt']);
    const result = await readSubmission(cwd, 'fallback');
    assert.equal(result.files.length, 1); assert.match(result.body, /```js/);
    assert.equal((await checkedGeneratedFile(cwd, result.files[0])).toString(), 'the generated answer');
    await writeFile(join(cwd, 'answer.txt'), 'changed content');
    await assert.rejects(checkedGeneratedFile(cwd, result.files[0]), /发生变化/);
    for (const path of ['../private.txt', join(home, 'private.txt'), 'C:\\private.txt']) { await manifest([path]); await assert.rejects(readSubmission(cwd, ''), /目录|相对路径/); }
    await symlink(join(home, 'private.txt'), join(cwd, 'escaped.txt')); await manifest(['escaped.txt']); await assert.rejects(readSubmission(cwd, ''), /超出/);
    await writeFile(join(cwd, 'oversized'), Buffer.alloc(8 * 1024 * 1024 + 1)); await manifest(['oversized']); await assert.rejects(readSubmission(cwd, ''), /8 MiB/);
    await manifest(Array.from({ length: 9 }, (_, i) => String(i))); await assert.rejects(readSubmission(cwd, ''), /8 个/);
    await manifest(['answer.txt', 'answer.txt']); await assert.rejects(readSubmission(cwd, ''), /重复/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
