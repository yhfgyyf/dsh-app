import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReleaseRuntime } from '../scripts/prepare-release-runtime.ts';

test('release runtime excludes the build fixture and retains built-in plugins', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'dsh-release-runtime-'));
  for (const path of ['plugins/dsh-p2p-collab', 'node_modules/dsh-p2p-collab', 'node_modules/dsh-audit-mode']) {
    await mkdir(join(runtime, path), { recursive: true });
    await writeFile(join(runtime, path, 'fixture.txt'), 'preserve built-in data');
  }
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'dsh-desktop-runtime', dependencies: {
    'dsh-p2p-collab': 'file:./plugins/dsh-p2p-collab', 'dsh-audit-mode': '0.6.1',
  } }));
  await prepareReleaseRuntime(runtime);
  await prepareReleaseRuntime(runtime);
  for (const path of ['plugins/dsh-p2p-collab', 'node_modules/dsh-p2p-collab']) {
    await assert.rejects(access(join(runtime, path)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(runtime, 'node_modules/dsh-audit-mode/fixture.txt'), 'utf8'), 'preserve built-in data');
  assert.deepEqual(JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).dependencies, { 'dsh-audit-mode': '0.6.1' });
  assert.deepEqual(JSON.parse(await readFile(join(runtime, 'local-plugins/package.json'), 'utf8')), { private: true });
});

test('release preparation rejects an unrelated runtime without removing files', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'dsh-release-runtime-'));
  await mkdir(join(runtime, 'plugins/dsh-p2p-collab'), { recursive: true });
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'user-profile' }));
  await assert.rejects(prepareReleaseRuntime(runtime));
  await access(join(runtime, 'plugins/dsh-p2p-collab'));
});
