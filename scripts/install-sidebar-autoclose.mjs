import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Preserve the pinned sidebar store's history and seed rules while closing an empty panel. */
export async function applySidebarAutoclose({ runtimeNodeModules = join(root, '.runtime/node_modules'), backupHome = join(root, '.build-runtime'), mode = 'apply' } = {}) {
  const base = runtimeNodeModules;
  const pkg = JSON.parse(await readFile(join(base, '@deepseek-ai/dsh-client-ui-sidebar-right/package.json'), 'utf8'));
  const dsh = pkg.version;
  const directory = join(root, 'patches', `dsh-${dsh}`, 'sidebar-autoclose');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (pkg.name !== manifest.package || (manifest.dsh && pkg.version !== manifest.dsh)) throw new Error('Unexpected sidebar package');
  const path = join(base, manifest.path), bytes = await readFile(path), digest = sha(bytes);
  if (manifest.upstream) {
    if (digest !== manifest.sha256) throw new Error('Unrecognized upstream sidebar changes preserved: ' + path);
    return mode === 'check' ? { pending: 0 } : { changed: 0, verified: true, upstream: true };
  }
  if (digest !== manifest.before && digest !== manifest.after) throw new Error('Unrecognized changes preserved: ' + path);
  const patch = join(directory, 'runtime.patch');
  if (sha(await readFile(patch)) !== manifest.patchSha256) throw new Error('Sidebar patch checksum differs');
  if (mode === 'check') return { pending: digest === manifest.after ? 0 : 1 };
  if (digest === manifest.after) return { changed: 0, verified: true };
  if (mode === 'verify') throw new Error('Sidebar autoclose patch is missing');
  const backup = join(backupHome, 'backups', 'sidebar-autoclose-' + new Date().toISOString().replace(/[:.]/g, '-'));
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
