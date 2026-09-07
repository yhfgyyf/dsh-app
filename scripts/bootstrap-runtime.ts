import { mkdir, readFile, writeFile, access, rename, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pins = JSON.parse(await readFile(join(root, 'runtime/dependencies.json'), 'utf8'));
const build = join(root, '.build-runtime');
const prefix = join(build, 'global');
const pluginRoot = join(build, 'plugins');
const globalRoot = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib/node_modules');
const installRoot = join(globalRoot, '@deepseek-ai/dsh');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run through npm: npm run setup:runtime');
if (process.version !== `v${pins.node}`) throw new Error(`Use Node ${pins.node} to produce the pinned runtime.`);
const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});
await mkdir(build, { recursive: true });
try { await access(prefix); await rename(prefix, join(build, `global-before-${Date.now()}`)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await run(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', `@deepseek-ai/dsh@${pins.dsh}`]);
const env = { ...process.env, DSH_HOME: join(build, 'patch-backups'), DSH_PATCH_GLOBAL_ROOT: globalRoot, DSH_INSTALL_ROOT: installRoot, DSH_PLUGIN_ROOT: pluginRoot };
const patch = join(root, 'patches', `dsh-${pins.dsh}`, 'apply.mjs');
await run(process.execPath, [patch, '--apply'], { env });
await run(process.execPath, [patch, '--verify'], { env });
await mkdir(pluginRoot, { recursive: true });
try { await symlink(join(installRoot, 'node_modules'), join(pluginRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
for (const [name, value] of Object.entries(pins.plugins) as [string, { repository: string; commit: string; version: string }][]) {
  if (!/^dsh-[a-z-]+$/.test(name) || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(value.repository) || !/^[a-f0-9]{40}$/.test(value.commit)) throw new Error('Invalid plugin pin');
  const directory = join(pluginRoot, name);
  await mkdir(directory, { recursive: true });
  await run('git', ['init', '--quiet'], { cwd: directory });
  await run('git', ['fetch', '--quiet', '--depth=1', `https://github.com/${value.repository}.git`, value.commit], { cwd: directory });
  await run('git', ['-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', value.commit], { cwd: directory });
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== name || pkg.version !== value.version) throw new Error(`Plugin identity differs: ${name}`);
}
await writeFile(join(build, 'source.json'), JSON.stringify({ installRoot, pluginRoot }, null, 2));
await run(process.execPath, [join(root, 'scripts/prepare-runtime.ts')], { env });
