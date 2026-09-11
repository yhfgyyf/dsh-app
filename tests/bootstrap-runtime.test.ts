import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { linkRuntimeDependencies } from '../scripts/runtime-dependencies.ts';

test('runtime lock fixes every DSH subpackage and preserves the snapshot dependency layout', async () => {
  const pins = JSON.parse(await readFile(new URL('../runtime/dependencies.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../runtime/dsh/package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../runtime/dsh/package-lock.json', import.meta.url), 'utf8'));
  const patch = JSON.parse(await readFile(new URL(`../patches/dsh-${pins.dsh}/manifest.json`, import.meta.url), 'utf8'));
  assert.deepEqual(manifest.dependencies, { '@deepseek-ai/dsh': pins.dsh });
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  const install = 'node_modules/@deepseek-ai/dsh';
  assert.equal(lock.packages[install].version, pins.dsh);
  const dshPackages = new Set<string>();
  for (const [path, value] of Object.entries(lock.packages) as [string, { version: string }][]) {
    if (!path || path === install) continue;
    assert.ok(path.startsWith(`${install}/node_modules/`), `Snapshot would omit ${path}`);
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (name.startsWith('@deepseek-ai/dsh-')) {
      assert.equal(value.version, pins.dsh, path);
      assert.equal(manifest.overrides[name], pins.dsh, name);
      dshPackages.add(name);
    }
  }
  assert.ok(dshPackages.size > 0);
  assert.deepEqual([...dshPackages].sort(), Object.keys(manifest.overrides).filter(name => name.startsWith('@deepseek-ai/dsh-')).sort());
  assert.equal(manifest.overrides['@earendil-works/pi-ai'], patch.piAi);
  assert.equal(lock.packages[`${install}/node_modules/@earendil-works/pi-ai`].version, patch.piAi);
  assert.equal(manifest.overrides.zod, '4.6.1');
  assert.equal(lock.packages[`${install}/node_modules/zod`].version, manifest.overrides.zod);
});

test('plugin dependency link is created once and remains unchanged on repeat setup', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-runtime-link-'));
  const target = join(scratch, 'target');
  const link = join(scratch, 'node_modules');
  await mkdir(target);
  await linkRuntimeDependencies(target, link);
  assert.equal(await realpath(link), await realpath(target));
  const original = await readlink(link);
  await linkRuntimeDependencies(target, link);
  assert.equal(await readlink(link), original);
  assert.deepEqual((await readdir(scratch)).sort(), ['node_modules', 'target']);
});

test('plugin dependency migration preserves the old link before adopting the current layout', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-runtime-link-'));
  const previous = join(scratch, 'global', 'lib', 'node_modules');
  const target = join(scratch, 'global', 'node_modules');
  const link = join(scratch, 'node_modules');
  await mkdir(previous, { recursive: true });
  await mkdir(target, { recursive: true });
  await linkRuntimeDependencies(previous, link);
  const original = await readlink(link);
  await linkRuntimeDependencies(target, link);
  assert.equal(await realpath(link), await realpath(target));
  const backups = (await readdir(scratch)).filter(name => name.startsWith('node_modules-before-'));
  assert.equal(backups.length, 1);
  assert.equal(await readlink(join(scratch, backups[0])), original);
});

test('plugin dependency migration preserves dangling links and existing directories', async () => {
  for (const kind of ['dangling', 'directory']) {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-runtime-link-'));
    const target = join(scratch, 'target');
    const previous = join(scratch, 'previous');
    const link = join(scratch, 'node_modules');
    await mkdir(target);
    if (kind === 'dangling') {
      await mkdir(previous);
      await linkRuntimeDependencies(previous, link);
      await rename(previous, `${previous}-saved`);
    } else {
      await mkdir(link);
      await writeFile(join(link, 'keep.txt'), 'preserved');
    }
    await linkRuntimeDependencies(target, link);
    assert.equal(await realpath(link), await realpath(target));
    const backups = (await readdir(scratch)).filter(name => name.startsWith('node_modules-before-'));
    assert.equal(backups.length, 1);
    const backup = join(scratch, backups[0]);
    if (kind === 'dangling') assert.ok((await lstat(backup)).isSymbolicLink());
    else assert.equal(await readFile(join(backup, 'keep.txt'), 'utf8'), 'preserved');
  }
});
