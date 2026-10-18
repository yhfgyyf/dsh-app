import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../.runtime/package.json', import.meta.url));
const { loadProfileDirectory } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);

test('loading a profile omits retired bundles without rewriting user configuration', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-profile-read-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const original = JSON.stringify({ private: true, description: 'Keep user data for rollback', dsh: { profile: {
    bundles: ['@deepseek-ai/dsh-experimental-schedule-bundle'],
  } } }, null, 4) + '\n';
  await writeFile(join(profile, 'package.json'), original);
  const loaded = loadProfileDirectory('read-fixture', profile, require.resolve('@deepseek-ai/dsh/package.json'));
  assert.deepEqual(loaded.layers, []);
  assert.deepEqual(loaded.skippedBundles, []);
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), original);
});
