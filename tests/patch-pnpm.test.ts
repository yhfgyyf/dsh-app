import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { patchPnpm } from '../scripts/patch-pnpm.ts';

const require = createRequire(import.meta.url);
const runtime = new URL('../.runtime/package-manager/node_modules/pnpm/', import.meta.url);

test('pinned pnpm atomic writes retry only bounded Windows rename interference', async t => {
  const data = await mkdtemp(join(tmpdir(), 'dsh-pnpm-rename-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  await mkdir(join(data, 'dist'));
  await writeFile(join(data, 'package.json'), JSON.stringify({ version: '11.7.0' }));
  await writeFile(join(data, 'dist/pnpm.mjs'), await readFile(new URL('dist/pnpm.mjs', runtime)));
  await patchPnpm(data);
  const source = await readFile(join(data, 'dist/pnpm.mjs'), 'utf8');
  await patchPnpm(data);
  assert.equal(await readFile(join(data, 'dist/pnpm.mjs'), 'utf8'), source, 'Patch must be idempotent');

  for (const version of ['7.0.1', '6.0.0']) {
    const marker = `write-file-atomic/${version}/`;
    const start = source.indexOf('(exports2, module2) {', source.indexOf(marker));
    const end = source.indexOf('\n  }\n});', start);
    assert.ok(start > 0 && end > start, 'Pinned write-file-atomic module missing');
    const body = source.slice(start + '(exports2, module2) {'.length, end);
    for (const fixture of [
      { platform: 'win32', code: 'EPERM', failures: 2, success: true, attempts: 3 },
      { platform: 'win32', code: 'EACCES', failures: 1, success: true, attempts: 2 },
      { platform: 'win32', code: 'EBUSY', failures: 1, success: true, attempts: 2 },
      { platform: 'win32', code: 'EPERM', failures: Infinity, success: false, attempts: 9 },
      { platform: 'win32', code: 'ENOSPC', failures: Infinity, success: false, attempts: 1 },
      { platform: 'darwin', code: 'EPERM', failures: Infinity, success: false, attempts: 1 },
    ]) await t.test(`${version} ${fixture.platform} ${fixture.code} failures=${fixture.failures}`, async () => {
      const dir = await mkdtemp(join(data, 'case-'));
      const target = join(dir, 'package.json');
      await writeFile(target, 'original');
      const calls: [string, string][] = [];
      const delays: number[] = [];
      const injected = Object.assign(new Error('Injected rename failure'), { code: fixture.code });
      const fixtureFs = { ...fs, rename(from: string, to: string, callback: (error: Error | null) => void) {
        calls.push([from, to]);
        assert.equal(fs.readFileSync(target, 'utf8'), 'original', 'Target must remain intact before rename');
        assert.equal(fs.readFileSync(from, 'utf8'), 'replacement', 'Complete temporary content must survive retries');
        if (calls.length <= fixture.failures) callback(injected);
        else fs.rename(from, to, callback);
      } };
      const module = { exports: {} as any };
      runInNewContext(`(function(module2) { ${body} })(module2)`, {
        module2: module,
        __require: (name: string) => name === 'fs' ? fixtureFs : require(name),
        __filename: 'pnpm.mjs',
        process: { platform: fixture.platform, pid: process.pid, getuid: undefined },
        require_cjs: () => ({ onExit: () => () => {} }),
        require_imurmurhash: () => () => ({ hash() { return this; }, result() { return 123456; } }),
        setTimeout: (callback: () => void, ms: number) => { delays.push(ms); queueMicrotask(callback); },
      });
      const operation = module.exports(target, 'replacement');
      if (fixture.success) await operation;
      else await assert.rejects(operation, error => error === injected);
      assert.equal(calls.length, fixture.attempts);
      assert.equal(new Set(calls.map(([from]) => from)).size, 1, 'Retry must retain the same temporary file');
      assert.equal(delays.length, fixture.attempts - 1);
      assert.ok(delays.every(ms => ms >= 20 && ms <= 200));
      if (fixture.attempts === 9) assert.deepEqual(delays, [20, 40, 80, 160, 200, 200, 200, 200]);
      assert.equal(await readFile(target, 'utf8'), fixture.success ? 'replacement' : 'original');
      assert.deepEqual(await readdir(dir), ['package.json'], 'Temporary file must be cleaned on success and final failure');
    });
  }
  await writeFile(join(data, 'dist/pnpm.mjs'), source + '\n// unrecognized drift\n');
  await assert.rejects(patchPnpm(data), /Unrecognized pnpm source/);
});
