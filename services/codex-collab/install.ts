import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, mkdir, readFile, rename, writeFile, lstat, realpath, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readConnection, callConnection } from './src/daemon.ts';
import { privateDirectory } from './src/storage.ts';

const exec = promisify(execFile), flags: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!['--codex-home', '--home', '--codex', '--model'].includes(flag) || !process.argv[i + 1]) throw new Error('Options: --codex-home DIR --home PROFILE --codex EXECUTABLE --model MODEL');
  flags[flag.slice(2)] = process.argv[i + 1];
}
if (process.platform === 'win32') throw new Error('Windows private profile support has not been validated.');
const codexHome = resolve(flags['codex-home'] ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
const profile = resolve(flags.home ?? process.env.CODEX_COLLAB_HOME ?? join(homedir(), '.local/share/dsh-codex-collab'));
const distribution = fileURLToPath(new URL('./dist', import.meta.url));
const destination = join(codexHome, 'plugins/local-sources/dsh-local');
const backup = join(codexHome, 'backups', 'dsh-codex-collab-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function executable(value: string) {
  for (const candidate of isAbsolute(value) ? [value] : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, value))) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new Error('Install Codex or provide --codex /absolute/path/to/codex.');
}
const codex = await executable(flags.codex ?? process.env.CODEX_COLLAB_CODEX ?? 'codex');
const env = { ...process.env, CODEX_HOME: codexHome };
const native = async (args: string[]) => JSON.parse((await exec(codex, args, { env, cwd: dirname(destination), timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout);
await access(join(distribution, 'plugins/dsh-codex-collab/cli.mjs'));
await privateDirectory(codexHome); await privateDirectory(profile); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
const running = await readConnection(profile);
if (running) {
  let live = false; try { process.kill(running.pid, 0); live = true; } catch {}
  if (live) { const state = await callConnection(running, 'status'); throw new Error(`Stop this profile's service before installing (${state.runningSessions.length} running sessions).`); }
}
const marketplaces = await native(['plugin', 'marketplace', 'list', '--json']);
const current = marketplaces.marketplaces.find((m: any) => m.name === 'dsh-local');
if (current && await realpath(current.root) !== await realpath(destination).catch(() => '')) throw new Error('The dsh-local marketplace name is already used by another source. Its files were preserved.');
if (flags.model && !/^[A-Za-z0-9._:/-]{1,160}$/.test(flags.model)) throw new Error('Invalid model name.');
await privateDirectory(backup);
const record: any = { version: 1, pluginId: 'dsh-codex-collab@dsh-local', status: 'preparing', createdAt: new Date().toISOString(), codexHome, profile, destination, backup, before: {} };
for (const [name, path] of [['config.toml', join(codexHome, 'config.toml')], ['codex-config.json', join(profile, 'codex-config.json')]]) {
  if (await exists(path)) {
    if (!(await lstat(path)).isFile()) throw new Error('Refusing to replace a non-file configuration.');
    const bytes = await readFile(path), copy = join(backup, name); await writeFile(copy, bytes, { mode: 0o600, flag: 'wx' });
    record.before[name] = { path, backup: copy, sha256: sha(bytes) };
  } else record.before[name] = { path, absent: true };
}
const save = () => writeFile(join(backup, 'install-record.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
await save();
const staging = destination + '.staging-' + randomUUID();
try {
  await cp(distribution, staging, { recursive: true, errorOnExist: true, force: false });
  const stagedPlugin = join(staging, 'plugins/dsh-codex-collab');
  // Portable manifests reject absolute executable paths. A contained launcher
  // preserves the exact validated Node binary even when the desktop has another PATH.
  const launcher = '#!/bin/sh\nexec ' + "'" + process.execPath.replaceAll("'", "'\\''") + "'" + ' "$@"\n';
  await writeFile(join(stagedPlugin, 'run-node'), launcher, { mode: 0o755 });
  await chmod(join(stagedPlugin, 'run-node'), 0o755);
  for (const file of ['mcp.json', '.mcp.json']) {
    const path = join(stagedPlugin, file), data = JSON.parse(await readFile(path, 'utf8'));
    data.mcpServers['dsh-collab'].command = file === 'mcp.json' ? './run-node' : process.execPath;
    data.mcpServers['dsh-collab'].env = { CODEX_COLLAB_CODEX: codex, CODEX_COLLAB_HOME: profile };
    await writeFile(path, JSON.stringify(data, null, 2) + '\n');
  }
  if (await exists(destination)) { record.previousSource = join(backup, 'marketplace'); await rename(destination, record.previousSource); await save(); }
  await rename(staging, destination);
  if (flags.model) await writeFile(join(profile, 'codex-config.json'), JSON.stringify({ model: flags.model }) + '\n', { mode: 0o600 });
  await native(['plugin', 'marketplace', 'add', destination, '--json']);
  record.installed = await native(['plugin', 'add', record.pluginId, '--json']);
  record.installedFiles = [];
  for (const file of ['cli.mjs', 'mcp.json', '.mcp.json', 'run-node']) {
    const expected = sha(await readFile(join(destination, 'plugins/dsh-codex-collab', file)));
    if (sha(await readFile(join(record.installed.installedPath, file))) !== expected) throw new Error('Installed plugin differs from the staged source: ' + file);
    record.installedFiles.push({ path: file, sha256: expected });
  }
  record.codexVersion = (await exec(codex, ['--version'], { env })).stdout.trim();
  record.afterConfigSha256 = sha(await readFile(join(codexHome, 'config.toml')));
  record.bundleSha256 = sha(await readFile(join(record.installed.installedPath, 'cli.mjs')));
  record.status = 'complete'; await save();
  console.log(JSON.stringify({ installed: record.installed, codexVersion: record.codexVersion, profile, model: flags.model ?? 'native-default', record: join(backup, 'install-record.json'), bundleSha256: record.bundleSha256 }, null, 2));
} catch (error) {
  record.status = 'failed'; record.error = error instanceof Error ? error.message : String(error); await save();
  throw new Error(`Installation did not complete. Original configurations and recovery record are at ${backup}. ${record.error}`);
}
