import { readFile, writeFile, mkdir, lstat, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function state(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error('Plugin patch target is not a regular file: ' + path);
    return { sha256: sha(await readFile(path)), mode: info.mode & 0o111 ? '100755' : '100644' };
  } catch (error) {
    if (error.code === 'ENOENT') return { sha256: null, mode: null };
    throw error;
  }
}

function matches(actual, hash, mode) {
  return actual.sha256 === hash && (process.platform === 'win32' || actual.mode === mode);
}

/** Reproduce the local plugin adaptations from their exact published Git pins. */
export async function applyPluginUpgrades({ pluginRoot = join(root, '.build-runtime/plugins'), backupHome = join(root, '.build-runtime'), mode = 'apply' } = {}) {
  if (!['apply', 'check', 'verify'].includes(mode)) throw new Error('Unknown plugin upgrade mode');
  const pins = JSON.parse(await readFile(join(root, 'runtime/dependencies.json'), 'utf8'));
  const directory = join(root, 'patches', `dsh-${pins.dsh}`, 'plugin-upgrades');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.dsh !== pins.dsh || manifest.plugins.length !== Object.keys(pins.plugins).length) throw new Error('Plugin upgrade manifest differs from runtime pins');
  const pending = [], seen = new Set();
  for (const plugin of manifest.plugins) {
    const pin = pins.plugins[plugin.name];
    if (!pin || seen.has(plugin.name) || !/^dsh-[a-z-]+$/.test(plugin.name) || plugin.commit !== pin.commit || plugin.version !== pin.version || plugin.repository !== pin.repository) throw new Error('Plugin upgrade identity differs: ' + plugin.name);
    seen.add(plugin.name);
    const base = join(pluginRoot, plugin.name), patch = join(directory, plugin.name + '.patch');
    const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
    if (pkg.name !== plugin.name || pkg.version !== pin.version) throw new Error('Unexpected plugin package: ' + plugin.name);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' });
    if (head.status !== 0 || head.stdout.trim() !== pin.commit) throw new Error('Plugin Git pin differs: ' + plugin.name);
    if (sha(await readFile(patch)) !== plugin.patchSha256) throw new Error('Plugin upgrade patch checksum differs: ' + plugin.name);
    const states = [];
    for (const file of plugin.files) {
      if (!file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(part => part === '..' || part === '.' || part === '.git' || part === 'node_modules')) throw new Error('Invalid plugin patch path');
      const actual = await state(join(base, file.path));
      if (matches(actual, file.after, file.afterMode)) states.push('after');
      else if (matches(actual, file.before, file.beforeMode)) states.push('before');
      else throw new Error('Unrecognized plugin changes preserved: ' + join(base, file.path));
    }
    if (states.every(value => value === 'after')) continue;
    if (states.some(value => value === 'after')) throw new Error('Partial plugin upgrade detected: ' + plugin.name);
    pending.push({ ...plugin, base, patch });
  }
  if (mode === 'check') return { pending: pending.length };
  if (!pending.length) return { changed: 0, verified: true };
  if (mode === 'verify') throw new Error('Plugin upgrades are missing');
  const apply = (plugin, check) => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', ...(check ? ['--check'] : []), plugin.patch], { cwd: plugin.base, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Plugin upgrade patch failed: ' + plugin.name);
  };
  for (const plugin of pending) apply(plugin, true);
  const backup = join(backupHome, 'backups', 'plugin-upgrades-' + new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const plugin of pending) for (const file of plugin.files) {
    if (file.before === null) continue;
    const target = join(backup, plugin.name, file.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(plugin.base, file.path), target);
    if (sha(await readFile(target)) !== file.before) throw new Error('Plugin upgrade backup verification failed');
  }
  for (const plugin of pending) apply(plugin, false);
  for (const plugin of pending) for (const file of plugin.files) {
    if (!matches(await state(join(plugin.base, file.path)), file.after, file.afterMode)) throw new Error('Plugin upgrade result checksum differs: ' + join(plugin.base, file.path));
  }
  return { changed: pending.length, verified: true, backup };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]?.replace(/^--/, '') ?? 'apply';
  if (!['apply', 'check', 'verify'].includes(mode) || process.argv.length > 3) throw new Error('Usage: install-plugin-upgrades.mjs [--apply|--check|--verify]');
  console.log(JSON.stringify(await applyPluginUpgrades({ mode })));
}
