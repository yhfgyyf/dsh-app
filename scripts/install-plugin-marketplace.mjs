import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Reuse the official controller and installer in a separately registered Settings page. */
export async function applyPluginMarketplace({ runtimeNodeModules = join(root, '.runtime/node_modules'), backupHome = join(root, '.build-runtime'), mode = 'apply' } = {}) {
  const directory = join(root, 'patches/dsh-0.1.6-alpha.2/plugin-marketplace');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const pending = [];
  for (const file of manifest.files) {
    const pkg = JSON.parse(await readFile(join(runtimeNodeModules, file.package, 'package.json'), 'utf8'));
    if (pkg.name !== file.package || pkg.version !== manifest.dsh) throw new Error('Unexpected plugin-marketplace package: ' + file.package);
    const path = join(runtimeNodeModules, file.path), bytes = await readFile(path), digest = sha(bytes);
    const variants = [{ before: file.before, patch: 'client.patch', patchSha256: file.patchSha256 }, ...(file.upgrades ?? [])];
    const variant = variants.find(candidate => candidate.before === digest);
    if (!variant && digest !== file.after) throw new Error('Unrecognized changes preserved: ' + path);
    for (const candidate of variants) if (sha(await readFile(join(directory, candidate.patch))) !== candidate.patchSha256) throw new Error('Plugin-marketplace patch checksum differs');
    if (variant) pending.push({ ...file, ...variant, path, bytes });
  }
  if (mode === 'check') return { pending: pending.length };
  if (!pending.length) return { changed: 0, verified: true };
  if (mode === 'verify') throw new Error('Plugin-marketplace adapter is missing');
  const backup = join(backupHome, 'backups', 'plugin-marketplace-' + new Date().toISOString().replace(/[:.]/g, '-'));
  for (const file of pending) {
    const path = join(backup, relative(runtimeNodeModules, file.path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
    if (sha(await readFile(path)) !== file.before) throw new Error('Plugin-marketplace backup verification failed');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-plugin-marketplace-'));
  try {
    for (const check of [true, false]) for (const file of pending) {
      const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--unsafe-paths', '--directory=' + runtimeNodeModules.replaceAll('\\', '/'), ...(check ? ['--check'] : []), join(directory, file.patch)], { cwd: scratch, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || 'Plugin-marketplace adapter failed');
    }
    for (const file of pending) if (sha(await readFile(file.path)) !== file.after) throw new Error('Plugin-marketplace result checksum differs');
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { changed: pending.length, verified: true, backup };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]?.replace(/^--/, '') ?? 'apply';
  if (!['apply', 'check', 'verify'].includes(mode) || process.argv.length > 3) throw new Error('Usage: install-plugin-marketplace.mjs [--apply|--check|--verify]');
  console.log(JSON.stringify(await applyPluginMarketplace({ mode })));
}
