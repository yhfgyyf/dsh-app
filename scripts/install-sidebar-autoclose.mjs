import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Preserve the pinned sidebar store's history and seed rules while closing an empty panel. */
export async function applySidebarAutoclose() {
  const { dsh } = JSON.parse(await readFile(join(root, 'runtime/dependencies.json'), 'utf8'));
  const directory = join(root, 'patches', `dsh-${dsh}`, 'sidebar-autoclose');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const base = join(root, '.runtime/node_modules');
  const pkg = JSON.parse(await readFile(join(base, manifest.package, 'package.json'), 'utf8'));
  if (pkg.name !== manifest.package || pkg.version !== dsh) throw new Error('Unexpected sidebar package');
  const path = join(base, manifest.path), bytes = await readFile(path), digest = sha(bytes);
  if (digest !== manifest.before && digest !== manifest.after) throw new Error('Unrecognized changes preserved: ' + path);
  const patch = join(directory, 'runtime.patch');
  if (sha(await readFile(patch)) !== manifest.patchSha256) throw new Error('Sidebar patch checksum differs');
  if (digest === manifest.after) return { changed: 0, verified: true };
  const backup = join(root, '.build-runtime/backups', 'sidebar-autoclose-' + new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, 'client.js'), bytes);
  if (sha(await readFile(join(backup, 'client.js'))) !== digest) throw new Error('Sidebar backup verification failed');
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-sidebar-autoclose-'));
  try {
    for (const check of [true, false]) {
      const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--unsafe-paths', '--directory=' + base.replaceAll('\\', '/'), ...(check ? ['--check'] : []), patch], { cwd: scratch, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || 'Sidebar patch failed');
    }
    if (sha(await readFile(path)) !== manifest.after) throw new Error('Sidebar result checksum differs');
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { changed: 1, verified: true, backup };
}
