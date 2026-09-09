import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function applyAuditCompat({ nodeModules, pluginRoot, backupHome = join(homedir(), '.dsh'), mode = 'apply' }) {
  const version = nodeModules
    ? JSON.parse(await readFile(join(nodeModules, '@deepseek-ai/dsh-tool-cordis/package.json'), 'utf8')).version
    : JSON.parse(await readFile(join(root, 'runtime/dependencies.json'), 'utf8')).dsh;
  const directory = join(root, 'patches', `dsh-${version}`, 'audit-compat');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const targets = [];
  for (const file of manifest.files) {
    const base = file.kind === 'runtime' ? nodeModules : pluginRoot;
    if (!base) continue;
    const packageFile = file.kind === 'runtime' ? join(base, '@deepseek-ai/dsh-tool-cordis/package.json') : join(base, 'package.json');
    const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
    const versions = file.kind === 'runtime' ? [manifest.dsh] : manifest.audit;
    const expectedName = file.kind === 'runtime' ? '@deepseek-ai/dsh-tool-cordis' : 'dsh-audit-mode';
    if (pkg.name !== expectedName || !versions.includes(pkg.version)) throw new Error('Unexpected audit compatibility target: ' + packageFile);
    const path = join(base, file.path), bytes = await readFile(path), digest = sha(bytes);
    if (digest !== file.before && digest !== file.after) throw new Error('Unrecognized changes preserved: ' + path);
    if (digest === file.before) targets.push({ ...file, base, path, bytes });
  }
  if (!targets.length) return { changed: 0, verified: true };
  if (mode === 'verify') throw new Error('Audit compatibility patch is missing');
  if (mode === 'check') return { pending: targets.length };
  const backup = join(backupHome, 'backups/audit-compat-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const target of targets) {
    await writeFile(join(backup, target.kind), target.bytes);
    if (sha(await readFile(join(backup, target.kind))) !== target.before) throw new Error('Audit backup verification failed');
    if (sha(await readFile(join(directory, target.kind + '.patch'))) !== target.patchSha256) throw new Error('Audit patch checksum differs');
  }
  await writeFile(join(backup, 'manifest.json'), JSON.stringify(targets.map(({ bytes, ...item }) => item), null, 2));
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-audit-compat-'));
  try {
    // Validate every hunk before writing any runtime target.
    for (const check of [true, false]) for (const target of targets) {
      const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--unsafe-paths', '--directory=' + target.base.replaceAll('\\', '/'), ...(check ? ['--check'] : []), join(directory, target.kind + '.patch')], { cwd: scratch, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || 'Audit compatibility patch failed');
    }
    for (const target of targets) if (sha(await readFile(target.path)) !== target.after) throw new Error('Audit compatibility checksum differs');
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { changed: targets.length, verified: true, backup };
}

async function main() {
  const args = process.argv.slice(2), mode = args.shift()?.replace(/^--/, '');
  if (!['apply', 'check', 'verify'].includes(mode) || args.length % 2) throw new Error('Usage: install-audit-compat.mjs --apply|--check|--verify [--runtime NODE_MODULES] [--plugin AUDIT_PACKAGE] [--home DSH_HOME]');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--runtime', '--plugin', '--home'].includes(args[i])) throw new Error('Unknown argument');
    options[args[i].slice(2)] = resolve(args[i + 1]);
  }
  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  if (options.runtime || options.plugin) console.log(JSON.stringify(await applyAuditCompat({ nodeModules: options.runtime, pluginRoot: options.plugin, backupHome: home, mode })));
  else {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    const targets = [
      { nodeModules: join(globalRoot, '@deepseek-ai/dsh/node_modules') },
      ...['web', 'tui'].map(profile => ({ pluginRoot: join(home, 'profiles', profile, 'node_modules/dsh-audit-mode') })),
    ];
    for (const target of targets) await applyAuditCompat({ ...target, backupHome: home, mode: 'check' });
    for (const target of targets) console.log(JSON.stringify(await applyAuditCompat({ ...target, backupHome: home, mode })));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
