import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { parseClientEndpoints } from '../dist/client-endpoints.js';

const SERVICE = 'dsh-relay.service';
const protocol = 'dsh-desktop-remote-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const hashFile = file => hash(readFileSync(file));
const optionalFile = file => existsSync(file) ? readFileSync(file, 'utf8') : null;
const safePath = value => isAbsolute(value) && !/[\r\n%"\\]/.test(value);
const quote = value => { if (!safePath(value)) throw new Error('Unsupported service path'); return `"${value}"`; };
let interrupted = false;
const checkpoint = () => { if (interrupted) throw new Error('Upgrade interrupted; restoring previous code'); };

export function defaultPaths(packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  return { packageDir, app: '/opt/dsh-relay', env: '/etc/dsh-relay.env',
    releases: '/opt/dsh-relay-releases', backups: '/var/backups/dsh-relay',
    dropin: '/etc/systemd/system/dsh-relay.service.d/90-dsh-relay-release.conf',
    lock: '/run/lock/dsh-relay-upgrade' };
}

function writeAtomic(file, data, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, data, { mode });
  chmodSync(temporary, mode);
  const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
const saveState = (backup, state) => writeAtomic(join(backup, 'upgrade-state.json'), JSON.stringify(state, null, 2) + '\n');

function run(command, args, options = {}) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim(); }
  catch { throw new Error(`${basename(command)} ${args[0] ?? ''} failed; inspect the service journal and backup directory`); }
}

/** Linux/systemd boundary; tests replace only this boundary and run real old/new relays. */
export function linuxService(paths) {
  const ctl = (...args) => run('systemctl', args);
  return {
    inspect() {
      const pid = Number(ctl('show', SERVICE, '-p', 'MainPID', '--value'));
      if (!Number.isInteger(pid) || pid < 2) throw new Error('Existing dsh-relay service must be running');
      const cwd = realpathSync(`/proc/${pid}/cwd`), node = realpathSync(`/proc/${pid}/exe`);
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (args.length !== 2) throw new Error('Expected the existing direct Node private-server service, without wrapper or extra arguments');
      const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(line => {
        const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
      }));
      const user = ctl('show', SERVICE, '-p', 'User', '--value');
      if (!user || user === 'root') throw new Error('Expected the existing unprivileged dsh-relay service user');
      if (!/^v22\./.test(run(node, ['--version']))) throw new Error('The existing service must use Node 22');
      return { pid, cwd, node, entry: resolve(cwd, args[1]), user, env };
    },
    configuration: () => ctl('cat', SERVICE),
    stop() {
      ctl('stop', SERVICE);
      if (Number(ctl('show', SERVICE, '-p', 'MainPID', '--value')) !== 0) throw new Error('Service did not stop; database was not copied');
    },
    reload: () => ctl('daemon-reload'),
    start() { ctl('reset-failed', SERVICE); ctl('start', SERVICE); },
    asUser: (info, args) => run('runuser', ['-u', info.user, '--', info.node, ...args]),
  };
}

function readConfig(paths) {
  const raw = readFileSync(paths.env, 'utf8');
  if (/^\s*export\s+(NODE_ENV|DB_PATH|HOST|PORT|PUBLIC_RELAY_URL|RELAY_CLIENT_ENDPOINTS)\s*=/m.test(raw)) throw new Error('systemd EnvironmentFile requires NAME=value assignments without the shell export keyword');
  const values = parseEnv(raw);
  if (!isAbsolute(values.DB_PATH ?? '') || !existsSync(values.DB_PATH) || !statSync(values.DB_PATH).isFile()) {
    throw new Error('DB_PATH must name the EXISTING absolute database file; no new database will be initialized');
  }
  const origin = new URL(values.PUBLIC_RELAY_URL);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Keep the existing HTTPS PUBLIC_RELAY_URL');
  if (values.NODE_ENV !== 'production' || !values.HOST || !/^\d+$/.test(values.PORT ?? '') || Number(values.PORT) < 1 || Number(values.PORT) > 65535) {
    throw new Error('Expected existing NODE_ENV=production, HOST and PORT settings');
  }
  if (values.RELAY_CLIENT_ENDPOINTS !== undefined) {
    try { parseClientEndpoints(JSON.parse(values.RELAY_CLIENT_ENDPOINTS)); }
    catch { throw new Error('Invalid RELAY_CLIENT_ENDPOINTS; use 1-6 unique HTTPS origins with private/public network labels'); }
  }
  return values;
}
const connection = values => Object.fromEntries(['DB_PATH', 'HOST', 'PORT', 'PUBLIC_RELAY_URL', 'NODE_ENV'].map(key => [key, values[key]]));
function sameConnection(actual, expected) {
  if (JSON.stringify(connection(actual)) !== JSON.stringify(connection(expected))) throw new Error('Active service and saved configuration differ in DB_PATH/HOST/PORT/PUBLIC_RELAY_URL/NODE_ENV; review before upgrading');
}
function healthUrl(config) {
  let host = config.HOST;
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `http://${host}:${config.PORT}/health`;
}
async function health(config) {
  const response = await fetch(healthUrl(config), { redirect: 'error', signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Relay health request failed');
  const reader = response.body.getReader(); let bytes = 0; const chunks = [];
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4096) throw new Error('Relay health response too large'); chunks.push(value); }
  } finally { await reader.cancel(); }
  const value = JSON.parse(Buffer.concat(chunks).toString());
  if (value.ok !== true || value.protocol !== protocol) throw new Error('This is not a compatible private relay');
  return value;
}

export function verifyPackage(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'PACKAGE-MANIFEST.json'), 'utf8'));
  if (manifest.protocol !== protocol || !/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,95}$/.test(manifest.releaseVersion ?? '')) throw new Error('Invalid upgrade package manifest');
  for (const file of manifest.files) {
    if (isAbsolute(file.path) || file.path.split('/').some(p => p === '..' || !p) || hashFile(join(packageDir, file.path)) !== file.sha256) throw new Error(`Package checksum mismatch: ${file.path}`);
  }
  if (!['dist/client-endpoints.js', 'dist/private-server.js', 'deploy/database-check.mjs', 'deploy/upgrade.mjs'].every(name => manifest.files.some(f => f.path === name))) throw new Error('Incomplete multi-network upgrade package');
  return manifest;
}

export async function checkUpgrade(paths, service) {
  const manifest = verifyPackage(paths.packageDir), info = service.inspect(), config = readConfig(paths);
  if (realpathSync(info.cwd) !== realpathSync(paths.app) || basename(info.entry) !== 'private-server.js' || !existsSync(info.entry)) throw new Error('Existing service layout differs from /opt/dsh-relay with private-server.js');
  const override = optionalFile(paths.dropin);
  if (override !== null && !override.startsWith('# Managed by DSH relay upgrade.')) throw new Error('The upgrade drop-in path already contains an unrelated configuration; it will not be overwritten');
  sameConnection(info.env, config);
  run(info.node, [join(paths.packageDir, 'deploy/database-check.mjs'), 'runtime']);
  const oldHealth = await health(config);
  return { manifest, info, config, oldHealth, envHash: hashFile(paths.env) };
}

function copyDatabase(source, destination) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const files = [];
  for (const suffix of ['', '-wal', '-shm']) {
    if (!existsSync(source + suffix)) continue;
    const original = statSync(source + suffix);
    copyFileSync(source + suffix, destination + suffix); chmodSync(destination + suffix, 0o600);
    const fd = openSync(destination + suffix, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    const sha256 = hashFile(source + suffix);
    if (hashFile(destination + suffix) !== sha256) throw new Error('Database backup checksum mismatch');
    files.push({ suffix, sha256, bytes: statSync(destination + suffix).size, mode: original.mode & 0o777, uid: original.uid, gid: original.gid });
  }
  const dir = openSync(dirname(destination), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  return files;
}

function readableCode(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  chmodSync(path, info.isDirectory() || (info.mode & 0o111) ? 0o755 : 0o644);
  if (info.isDirectory()) for (const name of readdirSync(path)) readableCode(join(path, name));
}

async function waitForService(service, state, entry, requireIdentity) {
  const deadline = Date.now() + 20_000;
  let stable = 0, lastPid, lastError;
  while (Date.now() < deadline) {
    if (requireIdentity) checkpoint();
    try {
      const info = service.inspect();
      sameConnection(info.env, state.connection);
      if (requireIdentity && (info.env.RELAY_CLIENT_ENDPOINTS ?? null) !== state.clientEndpoints) throw new Error('The running service did not load the configured phone endpoints');
      if (info.entry !== entry || info.cwd !== state.previous.cwd) throw new Error('Service started the wrong code directory');
      const result = await health(state.connection);
      if (requireIdentity) {
        const saved = JSON.parse(service.asUser(info, [join(state.release, 'deploy/database-check.mjs'), 'identity', state.connection.DB_PATH]));
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(result.relayId ?? '') || saved.relayId !== result.relayId) throw new Error('New relay did not open the existing database');
      } else if (state.previous.relayId && state.previous.relayId !== result.relayId) throw new Error('Previous relay identity differs');
      stable = info.pid === lastPid ? stable + 1 : 1; lastPid = info.pid;
      if (stable >= 3) return;
    } catch (error) { stable = 0; lastError = error.message; }
    await delay(500);
  }
  throw new Error(`Service did not pass stable process/database/health checks within 20 seconds: ${lastError ?? 'unstable process'}`);
}

export async function rollbackUpgrade(paths, service, backup) {
  if (dirname(resolve(backup)) !== resolve(paths.backups)) throw new Error('Rollback must name one backup directly inside the backup directory');
  const state = JSON.parse(readFileSync(join(backup, 'upgrade-state.json'), 'utf8'));
  if (state.schema !== 1 || state.service !== SERVICE || state.dropin !== paths.dropin || state.env !== paths.env) throw new Error('Backup does not belong to this service');
  sameConnection(readConfig(paths), state.connection);
  const current = optionalFile(paths.dropin);
  if (current !== state.installedDropin && current !== state.previous.dropin) throw new Error('Startup override changed after this upgrade; refusing to overwrite a later deployment');
  if (!existsSync(state.previous.entry) || hashFile(state.previous.entry) !== state.previous.entryHash) throw new Error('Previous server entry is missing or changed; do not replace it with unrelated code');
  state.phase = 'rolling-back'; saveState(backup, state);
  await service.stop();
  if (state.previous.dropin === null) { if (existsSync(paths.dropin)) unlinkSync(paths.dropin); }
  else writeAtomic(paths.dropin, state.previous.dropin, state.previous.dropinMode ?? 0o644);
  await service.reload(); await service.start();
  await waitForService(service, state, state.previous.entry, false);
  state.phase = 'rolled-back'; state.rolledBackAt = new Date().toISOString(); saveState(backup, state);
  return state;
}

export async function applyUpgrade(paths, service, log = console.log) {
  const checked = await checkUpgrade(paths, service); checkpoint();
  const tag = `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`;
  const release = join(paths.releases, `${checked.manifest.releaseVersion}-${tag}`), backup = join(paths.backups, tag);
  mkdirSync(release, { recursive: true, mode: 0o755 });
  // Copy only the reviewed package and target-built dependencies. Never copy a live .env, data or certificate tree.
  for (const name of [...checked.manifest.files.map(f => f.path), 'PACKAGE-MANIFEST.json']) {
    const dest = join(release, name); mkdirSync(dirname(dest), { recursive: true, mode: 0o755 }); copyFileSync(join(paths.packageDir, name), dest); chmodSync(dest, 0o644);
  }
  cpSync(realpathSync(join(paths.packageDir, 'node_modules')), join(release, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  readableCode(release);
  verifyPackage(release);
  service.asUser(checked.info, [join(release, 'deploy/database-check.mjs'), 'runtime']);
  checkpoint();
  mkdirSync(paths.backups, { recursive: true, mode: 0o700 }); chmodSync(paths.backups, 0o700);
  mkdirSync(backup, { mode: 0o700 });
  const entry = join(release, 'dist/private-server.js');
  const state = { schema: 1, service: SERVICE, phase: 'prepared', createdAt: new Date().toISOString(),
    release, dropin: paths.dropin, env: paths.env, envHash: checked.envHash, connection: connection(checked.config),
    clientEndpoints: checked.config.RELAY_CLIENT_ENDPOINTS ?? null,
    previous: { cwd: checked.info.cwd, node: checked.info.node, entry: checked.info.entry, entryHash: hashFile(checked.info.entry),
      dropin: optionalFile(paths.dropin), dropinMode: existsSync(paths.dropin) ? statSync(paths.dropin).mode & 0o777 : undefined,
      relayId: checked.oldHealth.relayId },
    installedDropin: `# Managed by DSH relay upgrade. Rollback journal: ${backup}\n[Service]\nExecStart=\nExecStart=${quote(checked.info.node)} ${quote(entry)}\n`,
  };
  saveState(backup, state);
  writeAtomic(join(backup, 'relay.env.before'), readFileSync(paths.env));
  writeAtomic(join(backup, 'service-before.txt'), service.configuration());
  log(`Backup and recovery journal: ${backup}`);
  log(`Rollback: sudo ${checked.info.node} ${join(release, 'deploy/upgrade.mjs')} rollback ${backup}`);
  try {
    if (hashFile(paths.env) !== state.envHash) throw new Error('Environment configuration changed during preparation');
    checkpoint(); state.phase = 'stopping'; saveState(backup, state); await service.stop();
    state.phase = 'stopped'; saveState(backup, state);
    const database = join(backup, 'database/private-relay.sqlite');
    state.databaseFiles = copyDatabase(state.connection.DB_PATH, database);
    const trial = join(backup, 'migration-check/private-relay.sqlite'); copyDatabase(database, trial);
    state.migration = JSON.parse(run(checked.info.node, [join(release, 'deploy/database-check.mjs'), 'verify-copy', trial]));
    saveState(backup, state); checkpoint();
    if (hashFile(paths.env) !== state.envHash) throw new Error('Environment configuration changed; startup switch cancelled');
    state.phase = 'switching'; saveState(backup, state);
    writeAtomic(paths.dropin, state.installedDropin, 0o644);
    await service.reload(); checkpoint(); await service.start();
    state.phase = 'checking'; saveState(backup, state);
    await waitForService(service, state, entry, true);
    if (hashFile(paths.env) !== state.envHash) throw new Error('Environment configuration changed during upgrade');
    state.phase = 'committed'; state.completedAt = new Date().toISOString(); saveState(backup, state);
    log('UPGRADE_OK: new code is healthy; existing database, environment, old code and TLS files retained.');
    return { backup, release };
  } catch (error) {
    log(`Upgrade failed: ${error.message}`);
    try { await rollbackUpgrade(paths, service, backup); log('ROLLBACK_OK: previous code is healthy; current registration database retained.'); }
    catch (restoreError) { log(`AUTOMATIC_ROLLBACK_FAILED: ${restoreError.message}. Recovery journal: ${backup}`); }
    throw error;
  }
}

function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || readdirSync(path).some(name => name !== 'owner.json')) throw new Error('Unexpected upgrade lock; inspect it before retrying');
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid < 2) throw new Error('Invalid upgrade lock');
    try { process.kill(owner.pid, 0); throw new Error(`An upgrade is already running (PID ${owner.pid})`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(join(path, 'owner.json')); rmdirSync(path);
  }
  mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  return () => { unlinkSync(join(path, 'owner.json')); rmdirSync(path); };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let unlock;
  try {
    const [action = 'check', backup, ...extra] = process.argv.slice(2);
    if (!['check', 'apply', 'rollback'].includes(action) || extra.length || (action === 'rollback') !== Boolean(backup)) throw new Error('Usage: sudo node deploy/upgrade.mjs check|apply|rollback <backup-directory>');
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Run with sudo on the existing Ubuntu/systemd server');
    if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Run this upgrade tool with Node 22');
    process.umask(0o022);
    const paths = defaultPaths(), service = linuxService(paths);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
    if (action === 'check') {
      const result = await checkUpgrade(paths, service);
      console.log(JSON.stringify({ ready: true, release: result.manifest.releaseVersion, node: result.info.node, currentCode: result.info.entry,
        database: result.config.DB_PATH, localHealth: healthUrl(result.config), mappedEntries: result.config.RELAY_CLIENT_ENDPOINTS ? JSON.parse(result.config.RELAY_CLIENT_ENDPOINTS).length : 0 }, null, 2));
    } else {
      unlock = acquireLock(paths.lock);
      if (action === 'apply') await applyUpgrade(paths, service);
      else { await rollbackUpgrade(paths, service, resolve(backup)); console.log('ROLLBACK_OK: previous code restored; current database and TLS configuration retained.'); }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { unlock?.(); }
}
