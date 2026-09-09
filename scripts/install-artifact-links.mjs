import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Version-pinned chat/Markdown adapter; never overwrite an unknown package edit. */
export async function applyArtifactLinks({ runtimeNodeModules = join(root, '.runtime/node_modules'), clientNodeModules = join(root, 'node_modules'), backupHome = join(root, '.build-runtime'), mode = 'apply' } = {}) {
  const { dsh } = JSON.parse(await readFile(join(root, 'runtime/dependencies.json'), 'utf8'));
  const directory = join(root, 'patches', `dsh-${dsh}`, 'artifact-links');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const pending = [];
  for (const file of manifest.files) {
    const base = file.kind === 'chat' ? runtimeNodeModules : clientNodeModules;
    const pkg = JSON.parse(await readFile(join(base, file.package, 'package.json'), 'utf8'));
    if (pkg.name !== file.package || pkg.version !== manifest.dsh) throw new Error('Unexpected artifact-link package: ' + file.package);
    const path = join(base, file.path), bytes = await readFile(path), digest = sha(bytes);
    if (digest !== file.before && digest !== file.after) throw new Error('Unrecognized changes preserved: ' + path);
    if (sha(await readFile(join(directory, file.kind + '.patch'))) !== file.patchSha256) throw new Error('Artifact-link patch checksum differs');
    if (digest === file.before) pending.push({ ...file, base, path, bytes });
  }
  if (mode === 'check') return { pending: pending.length };
  if (!pending.length) return { changed: 0, verified: true };
  if (mode === 'verify') throw new Error('Artifact-link adapter is missing');
  const backup = join(backupHome, 'backups', 'artifact-links-' + new Date().toISOString().replace(/[:.]/g, '-'));
  for (const file of pending) {
    const path = join(backup, file.kind, relative(file.base, file.path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
    if (sha(await readFile(path)) !== file.before) throw new Error('Artifact-link backup verification failed');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-artifact-links-'));
  try {
    for (const check of [true, false]) for (const file of pending) {
      const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--unsafe-paths', '--directory=' + file.base.replaceAll('\\', '/'), ...(check ? ['--check'] : []), join(directory, file.kind + '.patch')], { cwd: scratch, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || 'Artifact-link adapter failed');
    }
    for (const file of pending) if (sha(await readFile(file.path)) !== file.after) throw new Error('Artifact-link result checksum differs');
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { changed: pending.length, verified: true, backup };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]?.replace(/^--/, '') ?? 'apply';
  if (!['apply', 'check', 'verify'].includes(mode) || process.argv.length > 3) throw new Error('Usage: install-artifact-links.mjs [--apply|--check|--verify]');
  console.log(JSON.stringify(await applyArtifactLinks({ mode })));
}
