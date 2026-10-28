import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const name = 'dsh-p2p-collab';
const bundleFiles = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml'];
const sha = value => createHash('sha256').update(value).digest('hex');
const fileHash = file => existsSync(file) ? sha(readFileSync(file)) : null;
const json = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Cannot parse an expected JSON file; content was not exported'); } };
const inside = (parent, path) => { const rel = relative(parent, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
function directory(path) {
  if (!path || !isAbsolute(path)) throw new Error('Specify existing absolute package, runtime, state, credentials and backup directories');
  const actual = realpathSync(path);
  if (!statSync(actual).isDirectory()) throw new Error('Expected an existing directory');
  return actual;
}
function atomic(file, content) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  // Windows FlushFileBuffers requires a writable handle. Keep the writer open
  // through synchronization, then close it before the atomic rename.
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  if (process.platform !== 'win32') { const parent = openSync(dirname(file), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); } }
}
const save = (backup, value) => atomic(join(backup, 'plugin-upgrade.json'), JSON.stringify(value, null, 2) + '\n');
export function inspectBundle(path) {
  const pkg = json(join(path, 'package.json'));
  if (pkg.name !== name || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version ?? '') || pkg.type !== 'module' || pkg.main !== 'index.js') throw new Error('Not a reviewed collaboration plugin bundle');
  if (readdirSync(path).sort().join('|') !== [...bundleFiles].sort().join('|')) throw new Error('Unexpected plugin files; review the bundle instead of copying arbitrary data');
  const hashes = {};
  for (const file of bundleFiles) {
    if (!lstatSync(join(path, file)).isFile()) throw new Error('Plugin bundle entries must be regular files');
    hashes[file] = fileHash(join(path, file));
  }
  for (const file of ['index.js', 'client.js']) {
    try { execFileSync(process.execPath, ['--check', join(path, file)], { stdio: 'pipe', timeout: 30_000 }); }
    catch { throw new Error('Plugin JavaScript syntax check failed'); }
  }
  return { version: pkg.version, hashes };
}
function identityFiles(options) {
  return { profile: join(options.stateHome, 'collaboration/profile.json'), recovery: join(options.stateHome, 'collaboration/recovery.json'),
    registration: join(options.credentialsHome, 'remote-access.json') };
}
function identityHashes(files) {
  return Object.fromEntries(Object.entries(files).map(([key, file]) => {
    if (existsSync(file) && (!lstatSync(file).isFile() || realpathSync(file) !== file)) throw new Error('Identity files must be regular files under their explicit state/credential directory');
    return [key, fileHash(file)];
  }));
}
function assertIdentity(files, hashes, includeProfile = true) {
  for (const [key, value] of Object.entries(hashes)) if ((includeProfile || key !== 'profile') && fileHash(files[key]) !== value) throw new Error('Identity file changed concurrently; preserve both snapshots and inspect before proceeding');
}
function inactiveProfile(file) {
  if (!existsSync(file)) throw new Error('Existing profile is required; this tool never creates or resets identities');
  const value = json(file);
  if (value.version !== 1 || typeof value.peerId !== 'string' || !value.runs || !value.attempts || typeof value.runs !== 'object' || typeof value.attempts !== 'object') throw new Error('Unrecognized existing collaboration profile');
  if (Object.values(value.runs).some(run => ['preparing', 'running'].includes(run.status)) || Object.values(value.attempts).some(attempt => attempt.desiredState === 'active' && !['completed', 'withdrawn', 'error'].includes(attempt.status))) throw new Error('Active collaboration work exists; pause it using the current plugin before exiting DSH');
  return value;
}
export function processBlocksPluginUpgrade(options, { command = '', name = '', executable = '' }, platform = process.platform) {
  if (platform === 'win32') {
    const normalized = value => value.replaceAll('\\', '/').toLowerCase();
    const executablePath = normalized(executable), executableName = name || executablePath.split('/').at(-1);
    if (/^(?:DSH(?: Desktop)?|deepseek-harness)\.exe$/i.test(executableName)) return true;
    if (!/^(?:node|electron)\.exe$/i.test(executableName)) return false;
    const argumentsText = normalized(command);
    return [options.runtimeRoot, options.stateHome, options.credentialsHome].some(path => {
      const target = normalized(path);
      return executablePath.startsWith(target + '/') || argumentsText.includes(target);
    });
  }
  const relevantRuntime = /(?:node|electron|dsh|deepseek)/i.test(command.split(/\s+/)[0] ?? '') && [options.runtimeRoot, options.stateHome, options.credentialsHome].some(path => command.includes(path));
  const desktop = /(?:^|[/\\])(?:DSH(?: Desktop)?|deepseek-harness)(?:\.exe|\.app|[ /\\]|$)/i.test(command);
  return relevantRuntime || desktop;
}
/** Inspect process arguments in memory only. No environment or command line is exported. */
export function assertProcessesStopped(options) {
  let entries;
  try {
    if (process.platform === 'win32') {
      const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
      entries = [].concat(JSON.parse(result)).map(row => {
        if (typeof row.Name !== 'string') throw new Error('Missing Windows process metadata');
        return { pid: row.ProcessId, name: row.Name, executable: row.ExecutablePath ?? '', command: row.CommandLine ?? '' };
      });
    } else {
      entries = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').map(line => { const match = line.match(/^\s*(\d+)\s+(.+)$/); return { pid: Number(match?.[1]), command: match?.[2] ?? '' }; });
    }
  } catch { throw new Error('Cannot verify stopped processes; do not upgrade with an unknown writer'); }
  for (const entry of entries) {
    const { pid } = entry;
    if (!pid || pid === process.pid || pid === process.ppid) continue;
    if (processBlocksPluginUpgrade(options, entry)) throw new Error(`A DSH desktop/runtime process is still running (PID ${pid}, ${entry.name ?? 'DSH runtime'}); exit it before upgrading`);
  }
}
function normalized(input) {
  const value = { ...input };
  for (const key of ['packageDir', 'runtimeRoot', 'stateHome', 'credentialsHome', 'backups']) value[key] = directory(value[key]);
  if (input.profileDir) value.profileDir = directory(input.profileDir);
  if (!value.profileDir && /(?:^|[/\\])[^/\\]+\.app(?:[/\\]|$)/i.test(value.runtimeRoot)) throw new Error('Refusing to modify a signed App bundle; use --profile for an existing external profile installation');
  if (inside(value.runtimeRoot, value.backups) || inside(value.backups, value.runtimeRoot) || inside(value.packageDir, value.backups)) throw new Error('Keep backups outside the runtime and incoming package');
  if (value.profileDir && (inside(value.runtimeRoot, value.profileDir) || inside(value.profileDir, value.backups) || inside(value.backups, value.profileDir))) throw new Error('Profile and backups must be outside the signed runtime and each other');
  return value;
}
function profileEntry(options) {
  // Node caches realpaths across createRequire instances. A fresh process must see
  // the new pnpm symlink after a package switch; this never executes plugin code.
  const node = join(options.runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  try {
    return realpathSync(execFileSync(node, ['--input-type=module', '-e', "import {createRequire} from 'node:module';process.stdout.write(createRequire(process.argv[1]).resolve('dsh-p2p-collab'));", join(options.profileDir, '.desktop.cordis.yml')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }).trim());
  } catch { throw new Error('Cannot resolve the external plugin using the runtime-owned Node'); }
}
export function checkPluginUpgrade(input, { processes = assertProcessesStopped } = {}) {
  const options = normalized(input), bundle = inspectBundle(options.packageDir), files = identityFiles(options);
  const profile = inactiveProfile(files.profile);
  if (!existsSync(files.registration)) throw new Error('Existing remote-access.json is required; registration must not be recreated');
  processes(options);
  const candidates = options.profileDir ? [join(options.profileDir, 'node_modules', name)] : [join(options.runtimeRoot, 'plugins', name), join(options.runtimeRoot, 'node_modules', name)];
  const targets = [...new Set(candidates.map(directory))];
  if (targets.some(path => !inside(options.profileDir ?? options.runtimeRoot, path) || inside(path, options.packageDir) || inside(options.packageDir, path))) throw new Error('Plugin targets must be existing independent directories inside the selected runtime/profile');
  const installed = targets.map(inspectBundle);
  if (installed.some(value => JSON.stringify(value) !== JSON.stringify(installed[0]))) throw new Error('Installed plugin copies differ; inspect their actual loader layout first');
  if (options.profileDir) {
    const manifest = json(join(options.profileDir, 'package.json'));
    // An existing plugin can be activated by a user patch rather than bundles.
    // Package upgrades preserve that selection and the optional patch verbatim.
    if (typeof manifest.dependencies?.[name] !== 'string') throw new Error('Profile mode requires this plugin to be an existing external dependency');
    if (!inside(targets[0], profileEntry(options))) throw new Error('Profile does not resolve the existing external plugin');
    for (const path of [join(options.runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), join(options.runtimeRoot, 'package-manager/node_modules/pnpm/bin/pnpm.mjs')]) if (!existsSync(path)) throw new Error('Profile mode requires the existing runtime-owned Node and pnpm');
  }
  return { options, bundle, files, targets, installed: installed[0], identity: identityHashes(files), peerDigest: sha(profile.peerId),
    pendingRuns: 0, readOnly: true };
}
function copyIdentity(files, destination) {
  mkdirSync(destination, { mode: 0o700 });
  for (const [key, file] of Object.entries(files)) if (existsSync(file)) { copyFileSync(file, join(destination, key + '.json')); chmodSync(join(destination, key + '.json'), 0o600); }
}
function acquire(backups) {
  const path = join(backups, '.collab-plugin-upgrade-lock');
  try { mkdirSync(path, { mode: 0o700 }); } catch { throw new Error('Plugin upgrade lock exists; inspect any interrupted upgrade before retrying'); }
  writeFileSync(join(path, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' });
  return () => { unlinkSync(join(path, 'pid')); rmdirSync(path); };
}
export function installPlugin(input, { offline = false, processes = assertProcessesStopped, afterSwitch = () => {}, packageOperation = installProfileArchive } = {}) {
  if (input.profileDir) return installProfilePlugin(input, { offline, processes, afterSwitch, packageOperation });
  if (!offline) throw new Error('Pause work, exit DSH, and explicitly pass --offline');
  const checked = checkPluginUpgrade(input, { processes }), { options, files, targets } = checked;
  const releaseLock = acquire(options.backups);
  const backup = join(options.backups, 'collab-plugin-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  const changed = [];
  try {
    mkdirSync(backup, { mode: 0o700 }); chmodSync(backup, 0o700); copyIdentity(files, join(backup, 'identity-before'));
    const state = { schema: 1, phase: 'prepared', options, identity: checked.identity, peerDigest: checked.peerDigest,
      previous: checked.installed, installed: checked.bundle, targets, changed };
    save(backup, state);
    for (const [index, target] of targets.entries()) {
      processes(options); inactiveProfile(files.profile); assertIdentity(files, checked.identity);
      const staged = join(dirname(target), `.${name}-${randomUUID()}`);
      cpSync(options.packageDir, staged, { recursive: true });
      if (JSON.stringify(inspectBundle(staged)) !== JSON.stringify(checked.bundle)) throw new Error('Staged plugin checksum mismatch');
      const old = join(backup, 'old-' + index);
      // Keep an independent copy first; rename within the runtime filesystem for cross-volume backups.
      cpSync(target, old, { recursive: true });
      const displaced = target + '.before-' + randomUUID();
      renameSync(target, displaced);
      changed.push({ target, old, displaced, installed: false }); save(backup, state);
      renameSync(staged, target); changed.at(-1).installed = true; save(backup, state);
      afterSwitch(index);
    }
    assertIdentity(files, checked.identity); processes(options);
    state.phase = 'committed'; save(backup, state);
    return { status: 'committed', backup, version: checked.bundle.version, identityUnchanged: true, restartAndAuthenticatedSmokePending: true };
  } catch (error) {
    for (const item of [...changed].reverse()) {
      if (existsSync(item.target)) renameSync(item.target, item.target + '.failed-' + randomUUID());
      if (existsSync(item.displaced)) renameSync(item.displaced, item.target);
    }
    if (existsSync(join(backup, 'plugin-upgrade.json'))) { const state = json(join(backup, 'plugin-upgrade.json')); state.phase = 'install-failed-code-restored'; save(backup, state); }
    throw error;
  } finally { releaseLock(); }
}
export function rollbackPlugin(input, backup, { offline = false, processes = assertProcessesStopped, beforeSwitch = () => {}, packageOperation = installProfileArchive } = {}) {
  if (input.profileDir) return rollbackProfilePlugin(input, backup, { offline, processes, beforeSwitch, packageOperation });
  if (!offline) throw new Error('Pause work, exit DSH, and explicitly pass --offline');
  const options = normalized(input);
  if (dirname(directory(backup)) !== options.backups) throw new Error('Rollback journal must be directly inside the selected backups directory');
  const state = json(join(backup, 'plugin-upgrade.json'));
  if (state.schema !== 1 || state.phase !== 'committed' || ['runtimeRoot', 'stateHome', 'credentialsHome', 'backups'].some(key => state.options[key] !== options[key])) throw new Error('Rollback journal does not match this installation');
  const files = identityFiles(options), current = inactiveProfile(files.profile), currentHashes = identityHashes(files);
  const before = inactiveProfile(join(backup, 'identity-before/profile.json'));
  if (before.peerId !== current.peerId || before.origin !== current.origin) throw new Error('Identity or relay changed after upgrade; preserve all files and review before rolling back');
  for (const [index, target] of state.targets.entries()) {
    if (JSON.stringify(inspectBundle(target)) !== JSON.stringify(state.installed) || JSON.stringify(inspectBundle(join(backup, 'old-' + index))) !== JSON.stringify(state.previous)) throw new Error('Installed or saved code changed; refusing to overwrite another upgrade');
  }
  processes(options);
  const releaseLock = acquire(options.backups), archive = join(backup, 'before-rollback-' + randomUUID()), switched = [];
  let profileProjected = false;
  try {
    copyIdentity(files, archive);
    // Old 0.1.6 cannot understand new shared-session event boundaries. Only restore
    // the already-paused scheduler fields. Current identity/drafts/cursor/settings stay.
    const projected = { ...current, runs: before.runs, attempts: before.attempts };
    processes(options); assertIdentity(files, currentHashes); beforeSwitch();
    for (const [index, target] of state.targets.entries()) {
      const staged = target + '.rollback-' + randomUUID(); cpSync(join(backup, 'old-' + index), staged, { recursive: true });
      const displaced = target + '.new-' + randomUUID(); renameSync(target, displaced);
      switched.push({ target, displaced }); renameSync(staged, target);
    }
    assertIdentity(files, currentHashes); atomic(files.profile, JSON.stringify(projected, null, 2) + '\n'); profileProjected = true;
    assertIdentity(files, currentHashes, false); processes(options);
    state.phase = 'rolled-back'; state.upgradedProfileArchive = archive; save(backup, state);
    return { status: 'rolled-back', version: state.previous.version, upgradedProfileArchive: archive,
      identityPreserved: true, pausedSchedulerRestored: true, seamlessRunResume: false };
  } catch (error) {
    for (const item of [...switched].reverse()) { if (existsSync(item.target)) renameSync(item.target, item.target + '.rollback-failed-' + randomUUID()); renameSync(item.displaced, item.target); }
    if (profileProjected) atomic(files.profile, readFileSync(join(archive, 'profile.json')));
    throw error;
  } finally { releaseLock(); }
}

const profileFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function profileProjection(options) {
  const manifest = json(join(options.profileDir, 'package.json'));
  const dependencies = { ...manifest.dependencies }; delete dependencies[name];
  return { manifest: canonical({ ...manifest, dependencies }), patch: fileHash(join(options.profileDir, 'cordis.patch.yml')),
    workspace: fileHash(join(options.profileDir, 'pnpm-workspace.yaml')) };
}
function archiveBundle(source, backup, label) {
  const folder = join(backup, label + '-source'), pkg = join(folder, 'package'); mkdirSync(folder); mkdirSync(pkg);
  for (const file of bundleFiles) copyFileSync(join(source, file), join(pkg, file));
  const archive = join(backup, label + '.tgz');
  try { execFileSync('tar', ['-czf', archive, '-C', folder, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'pipe', timeout: 30_000 }); }
  catch { throw new Error('Cannot create the retained local plugin archive; no installation was started'); }
  chmodSync(archive, 0o600); return archive;
}
// pnpm persists file dependencies with forward slashes, including Windows drives.
export const archiveSpecifier = archive => `file:${archive.replaceAll('\\', '/')}`;
/** The official engine used by PluginManager.installBundle and dsh plugin; no app boot or credential access. */
export async function installProfileArchive(options, archive) {
  const require = createRequire(join(options.runtimeRoot, 'package.json'));
  const { runPluginCommand } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href);
  const node = join(options.runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const pnpm = join(options.runtimeRoot, 'package-manager/node_modules/pnpm/bin/pnpm.mjs');
  let result;
  try {
    result = await runPluginCommand({ profile: basename(options.profileDir), dir: options.profileDir, installAnchor: join(options.runtimeRoot, 'package.json'), cwd: dirname(archive), home: options.stateHome },
      ['add', '--offline', '--ignore-scripts', '--save-exact', archiveSpecifier(archive)],
      { command: node, args: ['--expose-internals', pnpm], env: { PATH: dirname(node) + delimiter + (process.env.PATH ?? '') }, execution: 'service', outputBytes: 8192, activateNewBundles: false, idleTimeoutMs: 30_000 });
  } catch { throw new Error('Official profile package operation could not complete; inspect the profile .plugin-manager/logs directory locally'); }
  const logPath = typeof result.logPath === 'string' && inside(join(options.profileDir, '.plugin-manager/logs'), result.logPath) ? result.logPath : null;
  if (result.exitCode !== 0) throw new Error('Official profile package operation failed; restricted diagnostic: ' + (logPath ?? 'unavailable'));
  return { exitCode: 0, diagnosticPath: logPath };
}
function verifyProfileInstall(options, expected, projection) {
  const target = directory(join(options.profileDir, 'node_modules', name));
  if (!inside(options.profileDir, target) || JSON.stringify(inspectBundle(target)) !== JSON.stringify(expected)) throw new Error('Official package operation did not install the expected plugin');
  if (JSON.stringify(profileProjection(options)) !== JSON.stringify(projection)) throw new Error('Unrelated profile manifest fields, dependencies or patches changed; inspect the retained profile files');
  if (!inside(target, profileEntry(options))) throw new Error('Profile module resolution did not select the external plugin');
}
async function installProfilePlugin(input, { offline, processes, afterSwitch, packageOperation }) {
  if (!offline) throw new Error('Pause work, exit DSH, and explicitly pass --offline');
  const checked = checkPluginUpgrade(input, { processes }), { options, files } = checked;
  const unlock = acquire(options.backups), backup = join(options.backups, 'collab-profile-' + randomUUID());
  let state, packageStarted = false;
  try {
    mkdirSync(backup, { mode: 0o700 }); chmodSync(backup, 0o700);
    copyIdentity(files, join(backup, 'identity-before')); mkdirSync(join(backup, 'profile-before'), { mode: 0o700 });
    for (const file of profileFiles) if (existsSync(join(options.profileDir, file))) { copyFileSync(join(options.profileDir, file), join(backup, 'profile-before', file)); chmodSync(join(backup, 'profile-before', file), 0o600); }
    const oldArchive = archiveBundle(checked.targets[0], backup, 'old-package'), newArchive = archiveBundle(options.packageDir, backup, 'new-package');
    state = { schema: 2, phase: 'prepared', options, identity: checked.identity, previous: checked.installed, installed: checked.bundle,
      oldArchive, oldArchiveHash: fileHash(oldArchive), newArchive, newArchiveHash: fileHash(newArchive), projection: profileProjection(options) };
    save(backup, state); processes(options); assertIdentity(files, state.identity);
    packageStarted = true;
    state.packageOperation = await packageOperation(options, newArchive); await afterSwitch(0);
    verifyProfileInstall(options, state.installed, state.projection); assertIdentity(files, state.identity); processes(options);
    state.phase = 'committed'; save(backup, state);
    return { status: 'committed', backup, version: state.installed.version, method: 'official-profile-package-operation', identityUnchanged: true, restartAndAuthenticatedSmokePending: true };
  } catch (error) {
    if (state && packageStarted) {
      try { processes(options); assertIdentity(files, state.identity); state.recoveryOperation = await packageOperation(options, state.oldArchive); verifyProfileInstall(options, state.previous, state.projection); assertIdentity(files, state.identity); processes(options); state.phase = 'install-failed-code-restored'; }
      catch { state.phase = 'install-failed-review-profile'; }
      save(backup, state);
    }
    throw error;
  } finally { unlock(); }
}
async function rollbackProfilePlugin(input, backup, { offline, processes, beforeSwitch, packageOperation }) {
  if (!offline) throw new Error('Pause work, exit DSH, and explicitly pass --offline');
  const options = normalized(input);
  if (dirname(directory(backup)) !== options.backups) throw new Error('Rollback journal must be directly inside the selected backups directory');
  const state = json(join(backup, 'plugin-upgrade.json'));
  if (state.schema !== 2 || state.phase !== 'committed' || ['runtimeRoot', 'profileDir', 'stateHome', 'credentialsHome', 'backups'].some(key => state.options[key] !== options[key]) || fileHash(state.oldArchive) !== state.oldArchiveHash || fileHash(state.newArchive) !== state.newArchiveHash) throw new Error('Profile rollback journal or retained archives changed');
  verifyProfileInstall(options, state.installed, state.projection);
  if (json(join(options.profileDir, 'package.json')).dependencies[name] !== archiveSpecifier(state.newArchive)) throw new Error('A subsequent plugin installation must not be overwritten');
  const files = identityFiles(options), current = inactiveProfile(files.profile), hashes = identityHashes(files), before = inactiveProfile(join(backup, 'identity-before/profile.json'));
  if (current.peerId !== before.peerId || current.origin !== before.origin) throw new Error('Identity or relay changed after upgrade; review before rolling back');
  processes(options);
  const unlock = acquire(options.backups), archive = join(backup, 'before-rollback-' + randomUUID());
  let packageStarted = false, projectedHash;
  try {
    copyIdentity(files, archive); await beforeSwitch(); assertIdentity(files, hashes); processes(options);
    state.phase = 'rolling-back'; state.upgradedProfileArchive = archive; save(backup, state);
    packageStarted = true;
    state.rollbackOperation = await packageOperation(options, state.oldArchive);
    verifyProfileInstall(options, state.previous, state.projection); assertIdentity(files, hashes);
    atomic(files.profile, JSON.stringify({ ...current, runs: before.runs, attempts: before.attempts }, null, 2) + '\n'); projectedHash = fileHash(files.profile);
    assertIdentity(files, hashes, false); processes(options);
    state.phase = 'rolled-back'; state.upgradedProfileArchive = archive; save(backup, state);
    return { status: 'rolled-back', version: state.previous.version, upgradedProfileArchive: archive, method: 'official-profile-package-operation', identityPreserved: true, pausedSchedulerRestored: true, seamlessRunResume: false };
  } catch (error) {
    let recovered = true;
    if (projectedHash) { try { processes(options); if (fileHash(files.profile) !== projectedHash) throw new Error('Profile changed concurrently'); atomic(files.profile, readFileSync(join(archive, 'profile.json'))); } catch { recovered = false; } }
    if (packageStarted && recovered) {
      try { processes(options); assertIdentity(files, hashes); state.recoveryOperation = await packageOperation(options, state.newArchive); verifyProfileInstall(options, state.installed, state.projection); assertIdentity(files, hashes); processes(options); }
      catch { recovered = false; }
    }
    state.phase = recovered ? 'committed' : 'rollback-failed-review-profile';
    state.lastRollbackAttempt = { status: recovered ? 'failed-new-code-restored' : 'recovery-required', profileArchive: archive };
    save(backup, state);
    throw error;
  } finally { unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action = 'check', ...args] = process.argv.slice(2), options = {}; let offline = false, backup;
    const keys = { '--package': 'packageDir', '--runtime': 'runtimeRoot', '--profile': 'profileDir', '--state-home': 'stateHome', '--credentials-home': 'credentialsHome', '--backups': 'backups' };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--offline') offline = true;
      else if (args[i] === '--backup' && args[i + 1]) backup = args[++i];
      else if (keys[args[i]] && args[i + 1]) options[keys[args[i]]] = args[++i];
      else throw new Error('Unknown/missing argument; see docs/COLLABORATION-UPGRADE-20261005.md');
    }
    if (!['check', 'apply', 'rollback'].includes(action) || (action === 'rollback') !== Boolean(backup)) throw new Error('Use check, apply --offline, or rollback --offline --backup PATH');
    if (action === 'check') { const value = checkPluginUpgrade(options); console.log(JSON.stringify({ readOnly: true, installedVersion: value.installed.version, incomingVersion: value.bundle.version, targets: value.targets, identityHashes: value.identity, peerDigest: value.peerDigest }, null, 2)); }
    else console.log(JSON.stringify(action === 'apply' ? await installPlugin(options, { offline }) : await rollbackPlugin(options, backup, { offline }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
