import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const marker = '# Managed by DSH collaboration upgrade.\n';
const sha = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => sha(readFileSync(path));
const optional = path => existsSync(path) ? readFileSync(path, 'utf8') : null;
const quote = path => { if (!isAbsolute(path) || /[\r\n%"\\$]/.test(path)) throw new Error('Unsupported absolute service path'); return `"${path}"`; };
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Cannot parse an expected JSON file; content was not exported'); } };
let interrupted = false;
const checkpoint = () => { if (interrupted) throw new Error('Upgrade interrupted; restore previous code with current database'); };
const run = (command, args) => {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`${basename(command)} operation failed; inspect restricted local diagnostics (no command output exported)`); }
};

function existing(path, directory = false) {
  if (!path || !isAbsolute(path)) throw new Error('Use existing absolute paths');
  const canonical = realpathSync(path), info = statSync(canonical);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('Unexpected path type');
  return canonical;
}
function atomic(path, data, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data, { mode, flag: 'wx' }); chmodSync(temporary, mode);
  const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}
const save = (backup, state) => atomic(join(backup, 'collaboration-upgrade.json'), JSON.stringify(state, null, 2) + '\n');
const sameFile = (a, b) => { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; };
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };

export function pathsFor(options) {
  if (!/^[A-Za-z0-9_-]+\.service$/.test(options.service ?? '') || !/^[A-Za-z0-9_-]+\.service$/.test(options.privateService ?? '') || options.service === options.privateService) throw new Error('Name distinct existing collaboration and private systemd services');
  const paths = { ...options, packageDir: existing(options.packageDir, true), env: existing(options.env),
    releases: existing(options.releases, true), backups: existing(options.backups, true) };
  if (within(paths.releases, paths.backups) || within(paths.backups, paths.releases) || within(paths.packageDir, paths.releases)) throw new Error('Package, release and backup directories must be separate');
  paths.dropin ??= `/etc/systemd/system/${paths.service}.d/90-dsh-collaboration-release.conf`;
  quote(paths.dropin);
  paths.lock ??= join(paths.backups, '.collaboration-upgrade-lock');
  return paths;
}

/** This boundary is replaced by a local child-process fixture in tests. */
export function linuxService(paths) {
  const ctl = (...args) => run('systemctl', args);
  const inspect = unit => {
    const pid = Number(ctl('show', unit, '-p', 'MainPID', '--value'));
    if (!Number.isInteger(pid) || pid < 2) throw new Error('Expected an existing running service');
    const cwd = realpathSync(`/proc/${pid}/cwd`), node = realpathSync(`/proc/${pid}/exe`);
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (argv.length !== 2) throw new Error('Only an existing direct Node service is supported; wrappers/containers require a reviewed deployment procedure');
    const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    const user = ctl('show', unit, '-p', 'User', '--value');
    if (!user || user === 'root' || !/^v22\./.test(run(node, ['--version']))) throw new Error('Expected an unprivileged Node 22 service');
    return { pid, cwd, node, user, entry: existing(resolve(cwd, argv[1])), env };
  };
  return {
    inspect: () => inspect(paths.service), inspectPrivate: () => inspect(paths.privateService),
    configuration: () => ctl('cat', paths.service),
    environmentFiles: () => ctl('show', paths.service, '-p', 'EnvironmentFiles', '--value'),
    stop() { ctl('stop', paths.service); if (Number(ctl('show', paths.service, '-p', 'MainPID', '--value')) !== 0) throw new Error('Collaboration service did not stop'); },
    reload: () => ctl('daemon-reload'),
    start() { ctl('reset-failed', paths.service); ctl('start', paths.service); },
    runtimeCheck(info, packageDir) { run('runuser', ['-u', info.user, '--', info.node, '--input-type=module', '-e', `import {createRequire} from 'node:module'; const D=createRequire(${JSON.stringify(join(packageDir, 'package.json'))})('better-sqlite3'); new D(':memory:').close();`]); },
  };
}

/** Run on the actual relay host. Lists only the requested process/path fields. */
export function discoverServices(procRoot = '/proc', environmentFiles = unit => run('systemctl', ['show', unit, '-p', 'EnvironmentFiles', '--value'])) {
  const services = []; let unreadableProcesses = 0;
  for (const pid of readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    try {
      const base = join(procRoot, pid), argv = readFileSync(join(base, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      if (!argv.some(argument => basename(argument) === 'collab-server.js')) continue;
      const cwd = realpathSync(join(base, 'cwd')), node = realpathSync(join(base, 'exe'));
      const cgroups = readFileSync(join(base, 'cgroup'), 'utf8');
      const units = [...new Set(cgroups.split(/[\/\n]/).filter(part => /^[A-Za-z0-9_-]+\.service$/.test(part)))];
      const unit = units.length === 1 ? units[0] : null;
      const line = readFileSync(join(base, 'environ'), 'utf8').split('\0').find(value => value.startsWith('COLLAB_DB_PATH='));
      let files = null;
      if (unit) { try { files = environmentFiles(unit); } catch { /* Do not infer configuration when systemd cannot identify it. */ } }
      services.push({ pid: Number(pid), node, cwd, entry: resolve(cwd, argv.find(argument => basename(argument) === 'collab-server.js')),
        systemdUnit: unit, collaborationDatabase: line ? line.slice('COLLAB_DB_PATH='.length) : null, environmentFiles: files });
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unreadableProcesses++; }
  }
  return { readOnly: true, services, unreadableProcesses, configurationNotInferred: true };
}

function configValues(env) {
  return { COLLAB_DB_PATH: env.COLLAB_DB_PATH, HOST: env.HOST ?? '127.0.0.1', COLLAB_PORT: env.COLLAB_PORT ?? '8788',
    RELAY_INTERNAL_URL: env.RELAY_INTERNAL_URL ?? 'http://127.0.0.1:8787', COLLAB_AUTH_SECRET: env.COLLAB_AUTH_SECRET };
}
function readConfig(paths) {
  const raw = readFileSync(paths.env, 'utf8');
  if (/^\s*export\s+/m.test(raw)) throw new Error('Use an existing systemd EnvironmentFile, not shell export statements');
  const config = configValues(parseEnv(raw));
  existing(config.COLLAB_DB_PATH);
  const url = new URL(config.RELAY_INTERNAL_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || typeof config.COLLAB_AUTH_SECRET !== 'string' || Buffer.byteLength(config.COLLAB_AUTH_SECRET) < 32) throw new Error('Existing collaboration configuration is incomplete');
  if (!/^\d+$/.test(config.COLLAB_PORT) || Number(config.COLLAB_PORT) < 1 || Number(config.COLLAB_PORT) > 65535) throw new Error('Invalid existing collaboration port');
  return config;
}
const configHash = config => sha(JSON.stringify(configValues(config)));
const privateFingerprint = info => ({ pid: info.pid, entry: info.entry, codeHash: fileHash(info.entry), configHash: sha(JSON.stringify(Object.keys(info.env).sort().map(key => [key, info.env[key]]))) });
function assertPrivate(service, expected) {
  if (JSON.stringify(privateFingerprint(service.inspectPrivate())) !== JSON.stringify(expected)) throw new Error('Private service changed concurrently; no private service changes are made by this tool');
}
function healthUrl(config) {
  let host = config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST === '::' ? '::1' : config.HOST;
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `http://${host}:${config.COLLAB_PORT}/health`;
}
async function health(config, upgraded = false) {
  const response = await fetch(healthUrl(config), { redirect: 'error', signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Collaboration health failed');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 4096) throw new Error('Health response too large'); chunks.push(value); } }
  finally { await reader.cancel(); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('Malformed collaboration health response'); }
  if (value.ok !== true || value.protocol !== 'dsh-collab-v1' || (upgraded && value.capabilities?.conversationWorkflow !== 1)) throw new Error('Unexpected collaboration protocol or workflow capability');
}

export function verifyPackage(packageDir) {
  const manifest = json(join(packageDir, 'PACKAGE-MANIFEST.json'));
  if (manifest.protocol !== 'dsh-desktop-remote-v1' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,95}$/.test(manifest.releaseVersion ?? '') || !Array.isArray(manifest.files)) throw new Error('Invalid reviewed relay package manifest');
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw new Error('Unsafe or duplicate package manifest path');
    seen.add(file.path);
    const path = join(packageDir, file.path);
    if (!within(packageDir, existing(path)) || fileHash(path) !== file.sha256) throw new Error('Package checksum mismatch');
  }
  if (!['package.json', 'dist/collab-server.js', 'dist/collab-store.js', 'dist/collab-auth.js', 'dist/collab-types.js', 'deploy/collaboration-upgrade.mjs'].every(file => seen.has(file))) throw new Error('Package lacks collaboration deployment files');
  for (const [path] of codeHashes(packageDir)) if (!seen.has(path)) throw new Error('Unlisted executable package file');
  return manifest;
}

function openDb(packageDir, path) {
  const Database = createRequire(join(packageDir, 'package.json'))('better-sqlite3');
  const db = new Database(existing(path), { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON'); db.pragma('busy_timeout = 5000');
  return db;
}
function verified(db) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('SQLite integrity or foreign key verification failed');
}
const identifier = name => { if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error('Unexpected database identifier'); return `"${name}"`; };
/** Hash row contents internally; never export credential values, task bodies or attachments. */
export function databaseSummary(packageDir, path, baseline) {
  const db = openDb(packageDir, path);
  try {
    db.exec('BEGIN'); verified(db);
    const tables = {};
    const names = baseline ? Object.keys(baseline.tables) : db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collab_%' ORDER BY name").all().map(row => row.name);
    if (!names.includes('collab_peers') || !names.includes('collab_tasks') || !names.includes('collab_replies')) throw new Error('Not an existing collaboration database');
    for (const table of names) {
      const columns = baseline?.tables[table].columns ?? db.pragma(`table_info(${identifier(table)})`).map(row => row.name);
      const digest = createHash('sha256'); let count = 0;
      for (const row of db.prepare(`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(table)} ORDER BY rowid`).iterate()) { digest.update(JSON.stringify(row) + '\n'); count++; }
      tables[table] = { columns, count, sha256: digest.digest('hex') };
    }
    const peerColumns = db.pragma('table_info(collab_peers)').map(row => row.name);
    const enrollment = peerColumns.includes('recoveryHash') ? "CASE WHEN recoveryHash IS NULL OR recoveryHash='' THEN 0 ELSE 1 END" : '0';
    const identities = db.prepare(`SELECT id,device,nickname,banned,${enrollment} AS recoveryEnrolled FROM collab_peers ORDER BY id`).all();
    const activeAttempts = names.includes('collab_attempts') ? db.prepare("SELECT count(*) AS n FROM collab_attempts WHERE status IN ('working','waiting')").get().n : 0;
    return { tables, identityDigest: sha(JSON.stringify(identities)), peerCount: identities.length, recoveryEnrolled: identities.filter(row => row.recoveryEnrolled).length, activeAttempts };
  } finally { db.close(); }
}
function registrationSummary(packageDir, path) {
  const db = openDb(packageDir, path);
  try {
    db.exec('BEGIN'); verified(db);
    const counts = {};
    for (const name of ['remote_accounts', 'remote_codes', 'remote_devices', 'remote_invites', 'remote_bindings']) counts[name] = db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n;
    const devices = db.prepare('SELECT id,name FROM remote_devices ORDER BY id').all();
    return { counts, registeredIdentityDigest: sha(JSON.stringify(devices)) };
  } finally { db.close(); }
}
function preserved(before, after) {
  if (JSON.stringify(before.tables) !== JSON.stringify(after.tables) || before.identityDigest !== after.identityDigest) throw new Error('Migration changed existing identities or history; upgrade refused');
}
export async function backupDatabase(packageDir, source, destination) {
  if (existsSync(destination)) throw new Error('Backup destination must be new');
  const db = openDb(packageDir, source);
  try { verified(db); await db.backup(destination); } finally { db.close(); }
  chmodSync(destination, 0o600);
  const copy = openDb(packageDir, destination); try { verified(copy); } finally { copy.close(); }
  const fd = openSync(destination, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  return { sha256: fileHash(destination), bytes: statSync(destination).size };
}
async function store(packageDir, path) {
  const { CollabStore } = await import(pathToFileURL(join(packageDir, 'dist/collab-store.js')).href);
  return new CollabStore(path);
}
/** Runs on a disposable backup only: additive migration, real old API writes, new API reads. */
export async function rehearseCompatibility(oldPackage, newPackage, copy) {
  const before = databaseSummary(oldPackage, copy);
  let instance = await store(newPackage, copy); instance.db.close();
  preserved(before, databaseSummary(newPackage, copy, before));
  instance = await store(oldPackage, copy);
  try {
    preserved(before, databaseSummary(oldPackage, copy, before));
    const peer = instance.join({ kind: 'desktop', role: 'control', deviceId: 'upgrade-probe-' + randomUUID() }, { id: randomUUID(), nickname: 'Offline upgrade probe' });
    const task = instance.createTask(peer, { operationId: randomUUID(), title: 'Offline compatibility probe', description: 'Disposable copy only', acceptance: 'Old write remains readable', tags: [] });
    const reply = instance.addReply(peer, task.id, { operationId: randomUUID(), actor: 'user', kind: 'message', body: 'old-code-write-on-copy', baseRevision: 1 });
    instance.db.close(); instance = await store(newPackage, copy);
    if (instance.db.prepare('SELECT body FROM collab_replies WHERE id=?').get(reply.id)?.body !== 'old-code-write-on-copy') throw new Error('New code could not read old-code writes');
    return { existingRowsPreserved: true, oldCodeWriteNewCodeRead: true, before };
  } finally { if (instance.db.open) instance.db.close(); }
}

export async function checkUpgrade(paths, service) {
  const manifest = verifyPackage(paths.packageDir), info = service.inspect(), privateInfo = service.inspectPrivate(), config = readConfig(paths);
  if (basename(info.entry) !== 'collab-server.js' || basename(dirname(info.entry)) !== 'dist' || basename(privateInfo.entry) !== 'private-server.js' || info.pid === privateInfo.pid) throw new Error('Actual service entry does not match the collaboration/private split');
  if (!service.environmentFiles().split(/\s+\(ignore_errors=(?:yes|no)\)\s*/).map(value => value.trim()).includes(paths.env)) throw new Error('Selected configuration is not in the service EnvironmentFiles');
  if (configHash(info.env) !== configHash(config) || privateInfo.env.COLLAB_AUTH_SECRET !== config.COLLAB_AUTH_SECRET) throw new Error('Active/saved collaboration configuration or existing shared authentication secret differs');
  if (!privateInfo.env.DB_PATH || sameFile(existing(privateInfo.env.DB_PATH), existing(config.COLLAB_DB_PATH))) throw new Error('Private registration and collaboration databases must be distinct');
  const oldPackage = dirname(dirname(info.entry));
  if (within(oldPackage, paths.releases) || within(oldPackage, paths.backups)) throw new Error('Release and backup directories must be outside the active code directory');
  const dropin = optional(paths.dropin);
  if (dropin !== null && !dropin.startsWith(marker)) throw new Error('Unrelated startup override exists; it will not be overwritten');
  service.runtimeCheck(info, paths.packageDir);
  await health(config);
  const summary = databaseSummary(paths.packageDir, config.COLLAB_DB_PATH);
  return { manifest, info, oldPackage, config, summary, envHash: fileHash(paths.env), private: privateFingerprint(privateInfo),
    privateDatabase: existing(privateInfo.env.DB_PATH), privateSummary: registrationSummary(paths.packageDir, privateInfo.env.DB_PATH),
    sharedCodeDirectory: oldPackage === dirname(dirname(privateInfo.entry)), configurationHash: sha(service.configuration()) };
}
function codeHashes(root) {
  const entries = [];
  const walk = path => { for (const name of readdirSync(path).sort()) { const file = join(path, name), info = lstatSync(file); if (info.isSymbolicLink()) throw new Error('Code tree contains a symbolic link'); if (info.isDirectory()) walk(file); else if (info.isFile()) entries.push([relative(root, file), fileHash(file)]); else throw new Error('Code tree contains a non-file'); } };
  walk(join(root, 'dist')); entries.push(['package.json', fileHash(join(root, 'package.json'))]);
  return entries;
}
function copyCode(source, target) {
  mkdirSync(target, { mode: 0o755 });
  codeHashes(source);
  cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true });
  copyFileSync(join(source, 'package.json'), join(target, 'package.json'));
  cpSync(realpathSync(join(source, 'node_modules')), join(target, 'node_modules'), { recursive: true, verbatimSymlinks: true });
}
async function waitHealthy(service, state, entry, upgraded) {
  let stable = 0, pid;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (upgraded) checkpoint();
    try {
      const info = service.inspect();
      if (info.entry !== entry || info.cwd !== state.previous.cwd || configHash(info.env) !== state.configHash) throw new Error('Unexpected restarted process');
      await health(configValues(info.env), upgraded); assertPrivate(service, state.private);
      stable = pid === info.pid ? stable + 1 : 1; pid = info.pid;
      if (stable >= 3) return;
    } catch { stable = 0; }
    await delay(250);
  }
  throw new Error('Collaboration did not pass stable process/configuration/health checks');
}

export async function rollbackUpgrade(paths, service, backup, { clientsPaused = false } = {}) {
  if (!clientsPaused) throw new Error('Pause all client work before rollback and pass --clients-paused');
  if (dirname(existing(backup, true)) !== paths.backups) throw new Error('Rollback must name a direct child of the configured backup directory');
  const state = json(join(backup, 'collaboration-upgrade.json'));
  if (state.schema !== 1 || state.service !== paths.service || state.dropin !== paths.dropin || state.env !== paths.env || fileHash(paths.env) !== state.envHash || configHash(readConfig(paths)) !== state.configHash) throw new Error('Rollback journal/configuration mismatch');
  if (![state.installedDropin, state.previous.dropin].includes(optional(paths.dropin))) throw new Error('A later startup configuration must not be overwritten');
  if (JSON.stringify(codeHashes(state.previous.packageDir)) !== JSON.stringify(state.previous.codeHashes)) throw new Error('Previous code changed; retained old-code backup is available for manual recovery');
  assertPrivate(service, state.private);
  if (databaseSummary(paths.packageDir, state.database).activeAttempts) throw new Error('Pause active collaboration attempts before rollback');
  state.phase = 'rolling-back'; save(backup, state);
  await service.stop();
  // Preserve post-upgrade messages. The snapshot is diagnostic only and is never restored.
  const currentCopy = join(backup, 'before-rollback-' + randomUUID() + '.sqlite');
  await backupDatabase(paths.packageDir, state.database, currentCopy);
  const before = databaseSummary(paths.packageDir, currentCopy);
  const previous = await store(state.previous.packageDir, currentCopy); previous.db.close();
  preserved(before, databaseSummary(state.previous.packageDir, currentCopy, before));
  if (state.previous.dropin === null) { if (existsSync(paths.dropin)) unlinkSync(paths.dropin); }
  else atomic(paths.dropin, state.previous.dropin, 0o644);
  await service.reload(); await service.start();
  await waitHealthy(service, state, state.previous.entry, false);
  state.phase = 'rolled-back'; state.rolledBackAt = new Date().toISOString(); save(backup, state);
  return { backup, status: state.phase, currentDatabaseRetained: true };
}

export async function applyUpgrade(paths, service, { clientsPaused = false, log = console.log } = {}) {
  if (!clientsPaused) throw new Error('Pause all client work before upgrade and pass --clients-paused');
  const checked = await checkUpgrade(paths, service);
  checkpoint();
  if (checked.summary.activeAttempts) throw new Error('Active collaboration attempts remain; pause them in the clients before upgrading');
  const tag = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const backup = join(paths.backups, tag), release = join(paths.releases, checked.manifest.releaseVersion + '-' + tag);
  mkdirSync(backup, { mode: 0o700 }); chmodSync(backup, 0o700);
  copyCode(paths.packageDir, release);
  mkdirSync(join(release, 'deploy')); copyFileSync(fileURLToPath(import.meta.url), join(release, 'deploy/collaboration-upgrade.mjs'));
  const selectedFiles = checked.manifest.files.filter(file => file.path.startsWith('dist/') || file.path === 'package.json' || file.path === 'deploy/collaboration-upgrade.mjs');
  atomic(join(release, 'PACKAGE-MANIFEST.json'), JSON.stringify({ ...checked.manifest, files: selectedFiles }), 0o644);
  verifyPackage(release); service.runtimeCheck(checked.info, release);
  copyCode(checked.oldPackage, join(backup, 'old-code'));
  const entry = join(release, 'dist/collab-server.js');
  const state = { schema: 1, service: paths.service, phase: 'prepared', release, database: checked.config.COLLAB_DB_PATH,
    privateDatabase: checked.privateDatabase, privateSummary: checked.privateSummary,
    env: paths.env, envHash: checked.envHash, configHash: configHash(checked.config), private: checked.private,
    dropin: paths.dropin, before: checked.summary, sharedCodeDirectory: checked.sharedCodeDirectory,
    previous: { packageDir: checked.oldPackage, entry: checked.info.entry, cwd: checked.info.cwd, node: checked.info.node,
      codeHashes: codeHashes(checked.oldPackage), dropin: optional(paths.dropin) },
    installedDropin: `${marker}[Service]\nExecStart=\nExecStart=${quote(checked.info.node)} ${quote(entry)}\n` };
  save(backup, state);
  atomic(join(backup, 'environment.before'), readFileSync(paths.env));
  atomic(join(backup, 'service.before'), service.configuration());
  log(`Prepared isolated release and restricted rollback journal: ${backup}`);
  try {
    if (fileHash(paths.env) !== state.envHash || sha(service.configuration()) !== checked.configurationHash) throw new Error('Service configuration changed during preparation');
    assertPrivate(service, state.private);
    checkpoint();
    state.phase = 'stopping'; save(backup, state);
    await service.stop(); state.phase = 'stopped'; save(backup, state);
    state.before = databaseSummary(release, state.database);
    if (state.before.activeAttempts) throw new Error('Work resumed during preparation; upgrade cancelled');
    state.databaseBackup = await backupDatabase(release, state.database, join(backup, 'collaboration.sqlite'));
    state.privateDatabaseBackup = await backupDatabase(release, state.privateDatabase, join(backup, 'private-registration.sqlite'));
    const trial = join(backup, 'compatibility-trial.sqlite');
    await backupDatabase(release, join(backup, 'collaboration.sqlite'), trial);
    state.compatibility = await rehearseCompatibility(checked.oldPackage, release, trial); save(backup, state);
    checkpoint();
    if (fileHash(paths.env) !== state.envHash) throw new Error('Environment changed; switch cancelled');
    atomic(paths.dropin, state.installedDropin, 0o644); state.phase = 'switching'; save(backup, state);
    await service.reload(); await service.start(); await waitHealthy(service, state, entry, true);
    preserved(state.before, databaseSummary(release, state.database, state.before));
    if (fileHash(paths.env) !== state.envHash) throw new Error('Environment changed during startup');
    state.phase = 'committed'; state.completedAt = new Date().toISOString(); save(backup, state);
    return { backup, release, status: 'committed', authenticatedClientSmokePending: true, privateServiceUnchanged: true };
  } catch (error) {
    try {
      if (['stopping', 'stopped'].includes(state.phase) && optional(paths.dropin) === state.previous.dropin) {
        // No new code has touched the live database. A late active attempt cancels the switch,
        // but must not block restarting the unchanged service via the manual rollback guard.
        if (fileHash(paths.env) !== state.envHash || sha(service.configuration()) !== checked.configurationHash || JSON.stringify(codeHashes(state.previous.packageDir)) !== JSON.stringify(state.previous.codeHashes)) throw new Error('Previous code or configuration changed during cancellation');
        assertPrivate(service, state.private);
        await service.start(); await waitHealthy(service, state, state.previous.entry, false);
        state.phase = 'cancelled'; state.cancelledAt = new Date().toISOString(); save(backup, state);
        log('CANCELLED_OLD_CODE_RUNNING: upgrade not selected; unchanged collaboration code and current database retained.');
      } else {
        await rollbackUpgrade(paths, service, backup, { clientsPaused: true }); log('ROLLBACK_OK: previous collaboration code; current database retained.');
      }
    }
    catch { log(`AUTOMATIC_ROLLBACK_FAILED: service may be stopped; preserve current database and inspect ${backup}`); }
    throw error;
  }
}

function lock(path) {
  try { mkdirSync(path, { mode: 0o700 }); } catch { throw new Error('Upgrade lock exists; inspect the previous journal and process before manually removing a stale lock'); }
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
  return () => { unlinkSync(join(path, 'owner.json')); rmdirSync(path); };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let unlock;
  try {
    const [action = 'check', ...args] = process.argv.slice(2), options = {}; let clientsPaused = false, backup;
    if (action === 'discover') {
      if (args.length || process.platform !== 'linux') throw new Error('Run discover without other arguments on the actual Linux relay host');
      console.log(JSON.stringify(discoverServices(), null, 2));
    } else {
    const keys = { '--service': 'service', '--private-service': 'privateService', '--env': 'env', '--package': 'packageDir', '--releases': 'releases', '--backups': 'backups' };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--clients-paused') clientsPaused = true;
      else if (args[i] === '--backup' && args[i + 1]) backup = args[++i];
      else if (keys[args[i]] && args[i + 1]) options[keys[args[i]]] = args[++i];
      else throw new Error('Unknown/missing argument; see docs/COLLABORATION-UPGRADE-20261005.md');
    }
    if (!['check', 'apply', 'rollback'].includes(action) || (action === 'rollback') !== Boolean(backup)) throw new Error('Use check, apply --clients-paused, or rollback --clients-paused --backup PATH');
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || Number(process.versions.node.split('.')[0]) !== 22) throw new Error('This deployment adapter requires Linux/systemd, root and Node 22; other deployments require their existing deployment system');
    const paths = pathsFor(options), service = linuxService(paths);
    if (action === 'check') {
      const value = await checkUpgrade(paths, service);
      console.log(JSON.stringify({ readOnly: true, release: value.manifest.releaseVersion, service: paths.service, currentCode: value.info.entry,
        database: value.config.COLLAB_DB_PATH, sharedCodeDirectory: value.sharedCodeDirectory, summary: value.summary, privateSummary: value.privateSummary,
        migrationTrialPending: true, authenticatedClientSmokePending: true }, null, 2));
    } else {
      unlock = lock(paths.lock);
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
      console.log(JSON.stringify(action === 'apply' ? await applyUpgrade(paths, service, { clientsPaused }) : await rollbackUpgrade(paths, service, backup, { clientsPaused }), null, 2));
    }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { unlock?.(); }
}
