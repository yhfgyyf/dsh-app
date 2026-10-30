import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { applyUpgrade, backupDatabase, checkUpgrade, databaseSummary, discoverServices, pathsFor, rollbackUpgrade } from '../deploy/collaboration-upgrade.mjs';

const relayRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(relayRoot, '../..');
const installerPath = join(project, 'scripts/install-collab-plugin.mjs');
const installer = existsSync(installerPath) ? await import(pathToFileURL(installerPath).href) : undefined;
const { archiveSpecifier, checkPluginUpgrade, inspectBundle, installPlugin, processBlocksPluginUpgrade, rollbackPlugin } = installer ?? {};
const pluginOnly = { skip: installer ? false : 'Desktop installer is outside the standalone relay archive; run these checks in the desktop source tree' };
const defaultArtifact = resolve(project, '../releases/relay-auth-compat-20261004/relay/relay-artifact.json');
const oldPackage = process.env.DSH_COLLAB_OLD_PACKAGE ?? (existsSync(defaultArtifact) ? JSON.parse(readFileSync(defaultArtifact, 'utf8')).stage : '');
const oldAvailable = existsSync(join(oldPackage, 'dist/collab-store.js'));
const oldOnly = { skip: oldAvailable ? false : 'Set DSH_COLLAB_OLD_PACKAGE to the verified 0.1.38-auth.1 package; real baseline evidence is required' };
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const Database = createRequire(join(relayRoot, 'package.json'))('better-sqlite3');

test('discovery identifies the actual collaboration process/unit and does not export other environment values', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-collaboration-discovery-')));
  try {
    const processDir = join(dir, '321'); mkdirSync(processDir);
    writeFileSync(join(processDir, 'cmdline'), '/usr/bin/node\0dist/collab-server.js\0');
    writeFileSync(join(processDir, 'cgroup'), '0::/system.slice/existing-collab.service\n');
    writeFileSync(join(processDir, 'environ'), 'COLLAB_AUTH_SECRET=do-not-export-this\0PASSWORD=also-private\0COLLAB_DB_PATH=/existing/data/collaboration.sqlite\0');
    symlinkSync(relayRoot, join(processDir, 'cwd')); symlinkSync(process.execPath, join(processDir, 'exe'));
    const result = discoverServices(dir, (unit: string) => { assert.equal(unit, 'existing-collab.service'); return '/etc/existing.env (ignore_errors=no)'; });
    assert.equal(result.services[0].systemdUnit, 'existing-collab.service');
    assert.equal(result.services[0].collaborationDatabase, '/existing/data/collaboration.sqlite');
    assert.doesNotMatch(JSON.stringify(result), /do-not-export-this|PASSWORD|also-private|COLLAB_AUTH_SECRET/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-collaboration-upgrade-')));
  const old = join(dir, 'old-shared-code'), candidate = join(dir, 'package');
  for (const path of [old, candidate, join(dir, 'releases'), join(dir, 'backups'), join(dir, 'data')]) mkdirSync(path);
  const manifest = JSON.parse(readFileSync(join(oldPackage, 'PACKAGE-MANIFEST.json'), 'utf8'));
  assert.equal(manifest.releaseVersion, '0.1.38-auth.1', 'The rollback fixture must be actual prior release code');
  for (const file of manifest.files) assert.equal(hash(join(oldPackage, file.path)), file.sha256, 'Prior release manifest must be intact');
  for (const [source, target] of [[oldPackage, old], [relayRoot, candidate]]) {
    cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true });
    copyFileSync(join(source, 'package.json'), join(target, 'package.json'));
    symlinkSync(join(relayRoot, 'node_modules'), join(target, 'node_modules'), 'dir');
  }
  mkdirSync(join(candidate, 'deploy'));
  copyFileSync(join(relayRoot, 'deploy/collaboration-upgrade.mjs'), join(candidate, 'deploy/collaboration-upgrade.mjs'));
  const files = ['package.json', 'deploy/collaboration-upgrade.mjs', ...readdirSync(join(candidate, 'dist')).map(file => 'dist/' + file)];
  const writeManifest = () => writeFileSync(join(candidate, 'PACKAGE-MANIFEST.json'), JSON.stringify({ releaseVersion: '0.1.38-collab-simple.1', protocol: 'dsh-desktop-remote-v1', files: files.map(path => ({ path, sha256: hash(join(candidate, path)) })) }));
  writeManifest();
  const { PrivateStore } = await import(pathToFileURL(join(old, 'dist/private-store.js')).href);
  const { createPrivateRelay } = await import(pathToFileURL(join(old, 'dist/private-server.js')).href);
  const { CollabStore } = await import(pathToFileURL(join(old, 'dist/collab-store.js')).href);
  const privatePath = join(dir, 'data/private.sqlite'), database = join(dir, 'data/collaboration.sqlite');
  const secret = 'offline-test-collaboration-secret-never-production';
  const privateStore = new PrivateStore(privatePath);
  privateStore.provision('test@example.test', 'fixture-password-long');
  const devices = [0, 1].map(index => privateStore.register(privateStore.registration('test@example.test'), 'Test device ' + index));
  const privateServer = createPrivateRelay(privateStore, 'http://127.0.0.1:8787', { collabSecret: secret });
  privateServer.server.listen(0, '127.0.0.1'); await once(privateServer.server, 'listening');
  const privateOrigin = `http://127.0.0.1:${privateServer.server.address().port}`;
  const tokens = await Promise.all(devices.map(async device => {
    const response = await fetch(privateOrigin + '/v1/collab-token', { method: 'POST', headers: { authorization: 'Bearer ' + device.deviceToken }, body: JSON.stringify({ deviceId: device.deviceId }) });
    assert.equal(response.status, 200); return (await response.json() as any).token;
  }));
  const store = new CollabStore(database);
  const peers = devices.map((device, index) => store.join({ kind: 'desktop', role: 'control', deviceId: device.deviceId }, { id: randomUUID(), nickname: 'Peer ' + index, recoverySecret: Buffer.alloc(32, index + 1).toString('base64url') }));
  const task = store.createTask(peers[0], { operationId: randomUUID(), title: 'Existing task', description: 'Preserve history', acceptance: 'Keep old validation valid', tags: [] });
  const solution = store.addReply(peers[1], task.id, { operationId: randomUUID(), actor: 'user', kind: 'solution', body: 'Existing candidate', baseRevision: 1, solution: { verification: 'old verification', limitations: '', report: null } });
  const validation = store.validate(peers[0], task.id, { operationId: randomUUID(), replyId: solution.id, baseRevision: 1, outcome: 'passed', method: 'fixture', environment: 'offline', evidence: 'verified before upgrade' });
  const identityBytes = JSON.stringify(store.db.prepare('SELECT * FROM collab_peers ORDER BY id').all());
  store.db.close();
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as any).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, envPath = join(dir, 'collaboration.env');
  writeFileSync(envPath, `COLLAB_DB_PATH=${database}\nHOST=127.0.0.1\nCOLLAB_PORT=${port}\nRELAY_INTERNAL_URL=${privateOrigin}\nCOLLAB_AUTH_SECRET=${secret}\n`, { mode: 0o600 });
  const envHash = hash(envPath), privateEntryHash = hash(join(old, 'dist/private-server.js'));
  const paths = pathsFor({ packageDir: candidate, env: envPath, service: 'dsh-collaboration.service', privateService: 'dsh-relay.service', releases: join(dir, 'releases'), backups: join(dir, 'backups'), dropin: join(dir, 'systemd/collaboration.conf') });
  let child: ChildProcess | undefined, info: any, starts = 0, stops = 0, candidateHook: (() => Promise<void>) | undefined, beforeStopHook: (() => Promise<void>) | undefined;
  const service = {
    inspect() { if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error('Inactive fixture process'); return { ...info, pid: child.pid }; },
    inspectPrivate() { return { pid: process.pid, cwd: old, entry: join(old, 'dist/private-server.js'), node: process.execPath, user: 'fixture', env: { DB_PATH: privatePath, COLLAB_AUTH_SECRET: secret } }; },
    configuration: () => '[Service]\nUser=fixture\nWorkingDirectory=' + old + '\n',
    environmentFiles: () => envPath,
    runtimeCheck(_info: unknown, packageDir: string) { new (createRequire(join(packageDir, 'package.json'))('better-sqlite3'))(':memory:').close(); },
    async stop() { if (beforeStopHook) { const hook = beforeStopHook; beforeStopHook = undefined; await hook(); } stops++; const previous = child; child = undefined; if (previous && previous.exitCode === null && previous.signalCode === null) { previous.kill('SIGTERM'); await once(previous, 'exit'); } },
    reload() {},
    async start() {
      starts++;
      const override = existsSync(paths.dropin) ? readFileSync(paths.dropin, 'utf8') : '';
      const entry = override.match(/^ExecStart="[^"]+" "([^"]+)"$/m)?.[1] ?? join(old, 'dist/collab-server.js');
      const env = parseEnv(readFileSync(envPath, 'utf8')); info = { cwd: old, entry, node: process.execPath, user: 'fixture', env };
      child = spawn(process.execPath, [entry], { cwd: old, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore'] });
      for (let tries = 0; ; tries++) {
        if (child.exitCode !== null || tries > 100) throw new Error('Fixture collaboration process failed');
        try { if ((await fetch(origin + '/health')).status === 200) break; } catch {}
        await delay(20);
      }
      if (entry !== join(old, 'dist/collab-server.js') && candidateHook) { const hook = candidateHook; candidateHook = undefined; await hook(); }
    },
  };
  const call = async (index: number, path: string, body?: object) => {
    const response = await fetch(origin + '/collab/v1/' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + tokens[index] }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, 'Authenticated fixture call ' + path); return await response.json() as any;
  };
  await service.start();
  return { dir, old, paths, service, database, peers, task, solution, validation, call, writeManifest,
    stats: () => ({ starts, stops }), setCandidateHook: (hook: () => Promise<void>) => { candidateHook = hook; }, setBeforeStopHook: (hook: () => Promise<void>) => { beforeStopHook = hook; },
    preserved() { assert.equal(hash(envPath), envHash); assert.equal(hash(join(old, 'dist/private-server.js')), privateEntryHash); const db = new Database(database, { readonly: true }); try { assert.equal(JSON.stringify(db.prepare('SELECT * FROM collab_peers ORDER BY id').all()), identityBytes); } finally { db.close(); } },
    async close() { await service.stop(); await privateServer.close(); privateStore.db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('read-only preflight detects shared code without stopping either service or exporting secrets', oldOnly, async () => {
  const f = await fixture();
  try {
    const checked = await checkUpgrade(f.paths, f.service);
    assert.equal(checked.sharedCodeDirectory, true); assert.equal(f.stats().stops, 0);
    const safeSummary = JSON.stringify(checked.summary);
    assert.doesNotMatch(safeSummary, /recoveryHash"\s*:\s*"|Existing candidate|fixture-password|offline-test-collaboration-secret/);
    f.preserved();
  } finally { await f.close(); }
});

test('actual auth.1 -> new -> auth.1 retains post-upgrade messages, credentials and old candidate validation', oldOnly, async () => {
  const f = await fixture();
  try {
    const result = await applyUpgrade(f.paths, f.service, { clientsPaused: true, log() {} });
    assert.equal((await f.call(0, 'me')).capabilities.conversationWorkflow, 1);
    const added = await f.call(1, `tasks/${f.task.id}/replies`, { operationId: randomUUID(), actor: 'user', kind: 'message', messageType: 'discussion', replyTo: f.solution.id, body: 'written after upgrade', baseRevision: 1 });
    f.preserved();
    await rollbackUpgrade(f.paths, f.service, result.backup, { clientsPaused: true });
    assert.equal((await f.call(0, `tasks/${f.task.id}`)).replies.find((reply: any) => reply.id === added.id).body, 'written after upgrade');
    const accepted = await f.call(0, `tasks/${f.task.id}/accept`, { operationId: randomUUID(), replyId: f.solution.id, validationId: f.validation.id, revision: 1 });
    assert.equal(accepted.status, 'resolved', 'Old candidate digest remains valid after new metadata exists');
    const current = databaseSummary(f.paths.packageDir, f.database);
    assert.equal(current.tables.collab_replies.count, 2); assert.equal(current.tables.collab_reply_metadata.count, 1);
    f.preserved();
    const state = JSON.parse(readFileSync(join(result.backup, 'collaboration-upgrade.json'), 'utf8'));
    assert.equal(state.compatibility.oldCodeWriteNewCodeRead, true);
  } finally { await f.close(); }
});

test('failure after new server accepted a message restores old code without restoring the old database', oldOnly, async () => {
  const f = await fixture(), logs: string[] = [];
  let message: any;
  try {
    f.setCandidateHook(async () => { message = await f.call(1, `tasks/${f.task.id}/replies`, { operationId: randomUUID(), actor: 'user', kind: 'message', body: 'accepted before failure', baseRevision: 1 }); throw new Error('Injected post-start failure'); });
    await assert.rejects(applyUpgrade(f.paths, f.service, { clientsPaused: true, log: (line: string) => logs.push(line) }), /Injected post-start failure/);
    assert.ok(logs.some(line => line.startsWith('ROLLBACK_OK:')));
    assert.equal((await f.call(0, `tasks/${f.task.id}`)).replies.find((reply: any) => reply.id === message.id).body, 'accepted before failure');
    f.preserved();
  } finally { await f.close(); }
});

test('work resumed after preflight cancels the switch and restarts the unchanged old service', oldOnly, async () => {
  const f = await fixture(), logs: string[] = [], attemptId = randomUUID();
  try {
    f.setBeforeStopHook(async () => { await f.call(1, `tasks/${f.task.id}/attempts`, { operationId: randomUUID(), id: attemptId, status: 'working', baseRevision: 1 }); });
    await assert.rejects(applyUpgrade(f.paths, f.service, { clientsPaused: true, log: (line: string) => logs.push(line) }), /Work resumed during preparation/);
    assert.equal(f.service.inspect().entry, join(f.old, 'dist/collab-server.js'), 'Cancellation must leave the original service running');
    assert.equal((await f.call(0, `tasks/${f.task.id}`)).attempts.find((attempt: any) => attempt.id === attemptId).status, 'working');
    assert.equal(existsSync(f.paths.dropin), false, 'The new release was never selected');
    assert.deepEqual(f.stats(), { starts: 2, stops: 1 });
    assert.ok(logs.some(line => line.startsWith('CANCELLED_OLD_CODE_RUNNING:')));
    assert.ok(!logs.some(line => line.startsWith('AUTOMATIC_ROLLBACK_FAILED:')));
    f.preserved();
  } finally { await f.close(); }
});

test('active attempts, missing database and changed package are refused before stopping; live WAL backup is complete', oldOnly, async () => {
  const f = await fixture();
  try {
    await assert.rejects(applyUpgrade(f.paths, f.service), /clients-paused/);
    await f.call(0, `tasks/${f.task.id}/attempts`, { operationId: randomUUID(), id: randomUUID(), status: 'working', baseRevision: 1 });
    await assert.rejects(applyUpgrade(f.paths, f.service, { clientsPaused: true }), /Active collaboration attempts/);
    const copy = join(f.dir, 'wal-backup.sqlite'); await backupDatabase(f.paths.packageDir, f.database, copy);
    assert.equal(databaseSummary(f.paths.packageDir, copy).tables.collab_attempts.count, 1);
    const env = readFileSync(f.paths.env, 'utf8'); writeFileSync(f.paths.env, env.replace(f.database, f.database + '.missing'));
    await assert.rejects(checkUpgrade(f.paths, f.service)); assert.equal(existsSync(f.database + '.missing'), false);
    writeFileSync(f.paths.env, env);
    writeFileSync(join(f.paths.packageDir, 'dist/collab-server.js'), '// changed package');
    await assert.rejects(checkUpgrade(f.paths, f.service), /checksum/);
    assert.equal(f.stats().stops, 0);
  } finally { await f.close(); }
});

function pluginFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-plugin-upgrade-')));
  const options = { packageDir: join(dir, 'incoming'), runtimeRoot: join(dir, 'runtime'), stateHome: join(dir, 'state'), credentialsHome: join(dir, 'credentials'), backups: join(dir, 'backups') };
  for (const path of Object.values(options)) mkdirSync(path);
  const targets = ['plugins', 'node_modules'].map(kind => join(options.runtimeRoot, kind, 'dsh-p2p-collab'));
  const bundle = (path: string, version: string) => { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'dsh-p2p-collab', version, type: 'module', main: 'index.js' })); writeFileSync(join(path, 'index.js'), `export const version = '${version}';\n`); writeFileSync(join(path, 'client.js'), 'const client = {};\n'); writeFileSync(join(path, 'cordis.patch.yml'), '- insert: []\n'); };
  for (const target of targets) bundle(target, '0.1.6'); bundle(options.packageDir, '0.2.0');
  mkdirSync(join(options.stateHome, 'collaboration'));
  const profilePath = join(options.stateHome, 'collaboration/profile.json');
  const profile = { version: 1, peerId: randomUUID(), nickname: 'Kept peer', origin: 'https://relay.invalid', cursor: 7, settings: { executionMode: 'manual' }, drafts: {}, runs: { old: { status: 'completed', sessionId: 'old-session' } }, attempts: { old: { status: 'paused', desiredState: 'paused' } } };
  writeFileSync(profilePath, JSON.stringify(profile)); writeFileSync(join(options.stateHome, 'collaboration/recovery.json'), '{"secret":"fixture-only-private-value"}'); writeFileSync(join(options.credentialsHome, 'remote-access.json'), '{"credential":"fixture-only-registration"}');
  return { dir, options, targets, profile, profilePath, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const stopped = () => {};

test('plugin journal and rollback satisfy the Windows writable-handle flush rule', pluginOnly, t => {
  const f = pluginFixture(), openFile = fs.openSync, syncFile = fs.fsyncSync, modes = new Map<number, string | number>();
  let fileFlushes = 0;
  try {
    t.mock.method(fs, 'openSync', (path: any, flags: any, mode: any) => { const fd = openFile(path, flags, mode); modes.set(fd, flags); return fd; });
    t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isFile()) {
        fileFlushes++;
        // Emulate FlushFileBuffers requiring GENERIC_WRITE, without claiming a Windows run.
        if (!/[wa+]/.test(String(modes.get(fd)))) throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' });
      }
      syncFile(fd);
    });
    syncBuiltinESMExports();
    const result = installPlugin(f.options, { offline: true, processes: stopped });
    assert.equal(result.status, 'committed');
    const installedFlushes = fileFlushes;
    const rolled = rollbackPlugin(f.options, result.backup, { offline: true, processes: stopped });
    assert.equal(rolled.status, 'rolled-back');
    assert.ok(installedFlushes > 0 && fileFlushes > installedFlushes, 'Both install and rollback retain real file synchronization');
    assert.deepEqual(JSON.parse(readFileSync(f.profilePath, 'utf8')), f.profile);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

const windowsProcessPaths = {
  runtimeRoot: 'D:\\Programs\\DSH Desktop\\resources\\runtime',
  stateHome: 'C:\\Users\\yhfgy\\AppData\\Roaming\\DSH Desktop\\core',
  credentialsHome: 'C:\\Users\\yhfgy\\AppData\\Roaming\\DSH Desktop',
};
test('Windows process guard ignores shell and Explorer arguments that only mention DSH directories', pluginOnly, () => {
  for (const entry of [
    { name: 'powershell.exe', executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', command: 'powershell.exe -File "D:\\DSH app\\windows\\collab-0.2.0\\upgrade-windows-collab-20261005.ps1" -Action apply' },
    { name: 'explorer.exe', executable: 'C:\\Windows\\explorer.exe', command: 'explorer.exe "D:\\DSH app\\windows\\collab-0.2.0"' },
    { name: 'Code.exe', executable: 'C:\\Programs\\Code.exe', command: 'Code.exe "C:\\Users\\yhfgy\\AppData\\Roaming\\DSH Desktop\\core\\profiles\\desktop\\package.json"' },
    { name: 'node.exe', executable: 'C:\\Program Files\\nodejs\\node.exe', command: 'node.exe unrelated-script.mjs "D:\\DSH app\\windows\\notes.txt"' },
  ]) assert.equal(processBlocksPluginUpgrade(windowsProcessPaths, entry, 'win32'), false, entry.name);
});
test('Windows process guard still blocks real DSH and runtime writers using executable metadata and path arguments', pluginOnly, () => {
  for (const entry of [
    { name: 'DSH Desktop.exe', executable: 'D:\\Programs\\DSH Desktop\\DSH Desktop.exe', command: '' },
    { name: 'deepseek-harness.exe', executable: 'D:\\Programs\\deepseek-harness.exe', command: '' },
    { name: 'node.exe', executable: 'D:\\Programs\\DSH Desktop\\resources\\runtime\\bin\\node.exe', command: '' },
    { name: 'NODE.EXE', executable: 'd:/programs/dsh desktop/resources/runtime/bin/node.exe', command: '' },
    { name: 'node.exe', executable: 'C:\\Program Files\\nodejs\\node.exe', command: 'node.exe service.mjs --state-home "C:\\Users\\yhfgy\\AppData\\Roaming\\DSH Desktop\\core"' },
    { name: 'electron.exe', executable: 'C:\\tools\\electron.exe', command: 'electron.exe "D:\\Programs\\DSH Desktop\\resources\\runtime\\app.js"' },
  ]) assert.equal(processBlocksPluginUpgrade(windowsProcessPaths, entry, 'win32'), true, entry.name);
});

test('retained archive references match pnpm Windows drive paths with spaces for install and rollback', pluginOnly, () => {
  assert.equal(archiveSpecifier('D:\\DSH app\\windows\\backups\\new-package.tgz'), 'file:D:/DSH app/windows/backups/new-package.tgz');
  assert.equal(archiveSpecifier('C:/Users/yhfgy/AppData/Roaming/DSH Desktop/backups/old-package.tgz'), 'file:C:/Users/yhfgy/AppData/Roaming/DSH Desktop/backups/old-package.tgz');
  assert.equal(archiveSpecifier('/Users/test/DSH Desktop/backups/new-package.tgz'), 'file:/Users/test/DSH Desktop/backups/new-package.tgz');
});

test('plugin package-only install preserves all identity bytes; rollback archives new history and restores only paused scheduler fields', pluginOnly, () => {
  const f = pluginFixture();
  try {
    const before = checkPluginUpgrade(f.options, { processes: stopped });
    const result = installPlugin(f.options, { offline: true, processes: stopped });
    assert.deepEqual(checkPluginUpgrade(f.options, { processes: stopped }).identity, before.identity);
    for (const target of f.targets) assert.equal(inspectBundle(target).version, '0.2.0');
    const updated = { ...f.profile, nickname: 'Updated nickname', cursor: 12, drafts: { new: { body: 'keep new draft' } },
      runs: { ...f.profile.runs, newer: { status: 'completed', sessionId: 'shared-new-session', eventStarts: { main: 4 }, eventEnds: { main: 8 } } },
      attempts: { newer: { status: 'paused', desiredState: 'paused', sessionId: 'shared-new-session' } } };
    writeFileSync(f.profilePath, JSON.stringify(updated));
    const rolled = rollbackPlugin(f.options, result.backup, { offline: true, processes: stopped });
    const after = JSON.parse(readFileSync(f.profilePath, 'utf8'));
    assert.deepEqual(after, { ...updated, runs: f.profile.runs, attempts: f.profile.attempts });
    assert.deepEqual(JSON.parse(readFileSync(join(rolled.upgradedProfileArchive, 'profile.json'), 'utf8')), updated);
    assert.equal(hash(join(f.options.stateHome, 'collaboration/recovery.json')), before.identity.recovery);
    assert.equal(hash(join(f.options.credentialsHome, 'remote-access.json')), before.identity.registration);
    for (const target of f.targets) assert.equal(inspectBundle(target).version, '0.1.6');
  } finally { f.close(); }
});

test('plugin upgrade refuses active work and running processes; partial switch failure restores both old copies', pluginOnly, () => {
  const f = pluginFixture();
  try {
    assert.throws(() => installPlugin(f.options, { processes: stopped }), /offline/);
    assert.throws(() => checkPluginUpgrade(f.options, { processes() { throw new Error('Process is still running'); } }), /still running/);
    writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, runs: { active: { status: 'running' } } }));
    assert.throws(() => installPlugin(f.options, { offline: true, processes: stopped }), /Active collaboration work/);
    writeFileSync(f.profilePath, JSON.stringify(f.profile));
    const before = hash(f.profilePath);
    assert.throws(() => installPlugin(f.options, { offline: true, processes: stopped, afterSwitch(index: number) { if (index === 0) throw new Error('Injected second-copy failure'); } }), /Injected/);
    for (const target of f.targets) assert.equal(inspectBundle(target).version, '0.1.6');
    assert.equal(hash(f.profilePath), before);
  } finally { f.close(); }
});

test('plugin rollback refuses changed identity and keeps current package/profile after a pre-switch failure', pluginOnly, () => {
  const f = pluginFixture();
  try {
    const result = installPlugin(f.options, { offline: true, processes: stopped });
    writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, peerId: randomUUID() }));
    assert.throws(() => rollbackPlugin(f.options, result.backup, { offline: true, processes: stopped }), /Identity or relay changed/);
    writeFileSync(f.profilePath, JSON.stringify(f.profile));
    assert.throws(() => rollbackPlugin(f.options, result.backup, { offline: true, processes: stopped, beforeSwitch() { throw new Error('Injected rollback failure'); } }), /Injected/);
    for (const target of f.targets) assert.equal(inspectBundle(target).version, '0.2.0');
    assert.deepEqual(JSON.parse(readFileSync(f.profilePath, 'utf8')), f.profile);
  } finally { f.close(); }
});

const packageRuntime = process.env.DSH_TEST_DESKTOP_RUNTIME ?? join(project, '.runtime');
async function officialReinstall(options: any, frozen = false) {
  const runtimeRequire = createRequire(join(options.runtimeRoot, 'package.json'));
  const { runPluginCommand } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href);
  return runPluginCommand({ profile: 'fixture', dir: options.profileDir, installAnchor: join(options.runtimeRoot, 'package.json'), cwd: options.stateHome, home: options.stateHome },
    ['install', '--offline', '--ignore-scripts', ...(frozen ? ['--frozen-lockfile'] : [])],
    { command: join(options.runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), args: ['--expose-internals', join(options.runtimeRoot, 'package-manager/node_modules/pnpm/bin/pnpm.mjs')], execution: 'service', outputBytes: 4096, activateNewBundles: false });
}
test('initial profile journal flush failure never starts package installation or recovery', {
  skip: installer && existsSync(join(packageRuntime, 'package-manager/node_modules/pnpm/bin/pnpm.mjs')) ? false : 'Requires the existing desktop runtime and official package manager',
}, async t => {
  const f = pluginFixture(), calls: string[] = [];
  try {
    const profileDir = join(f.dir, 'profile'); mkdirSync(profileDir); mkdirSync(join(profileDir, 'node_modules'));
    cpSync(f.targets[0], join(profileDir, 'node_modules/dsh-p2p-collab'), { recursive: true });
    const manifestPath = join(profileDir, 'package.json');
    writeFileSync(manifestPath, JSON.stringify({ name: 'failed-journal-fixture', private: true, dependencies: { 'dsh-p2p-collab': 'file:' + f.targets[0] }, dsh: { profile: { bundles: [] } } }));
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n');
    const options = { ...f.options, runtimeRoot: packageRuntime, profileDir };
    const before = { manifest: hash(manifestPath), profile: hash(f.profilePath), bundle: inspectBundle(join(profileDir, 'node_modules/dsh-p2p-collab')) };
    t.mock.method(fs, 'fsyncSync', () => { throw new Error('Injected initial journal flush failure'); });
    syncBuiltinESMExports();
    await assert.rejects(installPlugin(options, { offline: true, processes: stopped, packageOperation: async (_options: unknown, archive: string) => { calls.push(archive); return { exitCode: 0 }; } }), /Injected initial journal flush failure/);
    assert.deepEqual(calls, [], 'A failed first journal write must not trigger even an old-package reinstall');
    assert.equal(hash(manifestPath), before.manifest); assert.equal(hash(f.profilePath), before.profile);
    assert.deepEqual(inspectBundle(join(profileDir, 'node_modules/dsh-p2p-collab')), before.bundle);
    assert.equal(existsSync(join(options.backups, '.collab-plugin-upgrade-lock')), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test('official profile package engine updates its durable dependency and a restarted official loader selects old/new/old external code', {
  skip: installer && existsSync(join(packageRuntime, 'package-manager/node_modules/pnpm/bin/pnpm.mjs')) ? false : 'Requires the existing desktop runtime and official package manager',
}, async t => {
  const f = pluginFixture();
  try {
    const profileDir = join(f.dir, 'profile'); mkdirSync(profileDir); mkdirSync(join(profileDir, 'node_modules'));
    const setup = (path: string, version: string) => {
      const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
      pkg.version = version; pkg.dsh = { bundle: { patch: './cordis.patch.yml' } };
      writeFileSync(join(path, 'package.json'), JSON.stringify(pkg));
      writeFileSync(join(path, 'index.js'), `export const name='dsh-p2p-collab'; export function apply(ctx) { ctx.provide('collabUpgradeVersion', '${version}'); }\n`);
      writeFileSync(join(path, 'cordis.patch.yml'), '- insert:\n    - id: p2p-collab\n      name: dsh-p2p-collab\n');
    };
    setup(f.targets[0], '0.1.5'); setup(f.options.packageDir, '0.2.0');
    cpSync(f.targets[0], join(profileDir, 'node_modules/dsh-p2p-collab'), { recursive: true });
    const unrelated = join(f.dir, 'unrelated'); mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'package.json'), JSON.stringify({ name: 'dsh-unrelated-upgrade-fixture', version: '1.0.0', main: 'index.js' })); writeFileSync(join(unrelated, 'index.js'), 'module.exports=42;\n');
    const manifest = { name: 'collab-upgrade-profile', version: '1.0.0', private: true, type: 'module',
      dependencies: { 'dsh-p2p-collab': 'file:' + f.targets[0], 'dsh-unrelated-upgrade-fixture': 'file:' + unrelated }, dsh: { profile: { bundles: ['dsh-p2p-collab'] } } };
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n');
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), JSON.stringify({ packages: [], offline: true, ignoreScripts: true, storeDir: join(f.dir, 'store'), cacheDir: join(f.dir, 'cache'), managePackageManagerVersions: false, updateNotifier: false }));
    const rootFile = join(profileDir, '.desktop.cordis.yml'); writeFileSync(rootFile, '[]\n');
    const options = { ...f.options, runtimeRoot: packageRuntime, profileDir };
    assert.equal((await officialReinstall(options)).exitCode, 0, 'Start from a real pnpm installation with the old virtual-store symlink');
    const load = () => {
      const code = `import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
      const runtime=${JSON.stringify(packageRuntime)}, dir=${JSON.stringify(profileDir)}, home=${JSON.stringify(f.options.stateHome)};
      process.env.DSH_HOME=home; process.env.DSH_TELEMETRY_DISABLED='1';
      const require=createRequire(runtime+'/package.json');
      const {boot,loadProfileDirectory,readProfilePatches,createRuntimeResolution,PluginPackages}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
      const profile=loadProfileDirectory('upgrade-test',dir,runtime+'/package.json');
      const pc={name:'test',dir,patchPath:profile.patchPath,installAnchor:runtime+'/package.json',startedBundles:profile.layers.map(l=>l.packageName),cwd:home,home,overlays:[]};
      const resolution=await createRuntimeResolution({installAnchor:pc.installAnchor,profile,home});
      const ctx=await boot('upgrade-test',dir+'/.desktop.cordis.yml',readProfilePatches('upgrade-test',pc,profile),async host=>{host.provide('profileContext',pc);await host.plugin(PluginPackages,{resolution});});
      console.log('UPGRADE_PROBE='+ctx.get('collabUpgradeVersion')); await ctx.fiber.dispose();`;
      return execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    };
    assert.match(load(), /UPGRADE_PROBE=0\.1\.5/);
    const appPackageHash = hash(join(packageRuntime, 'package.json'));
    const initialProfile = readFileSync(f.profilePath, 'utf8'), patchHash = hash(join(profileDir, 'cordis.patch.yml'));
    const result = await installPlugin(options, { offline: true, processes: stopped });
    assert.match(load(), /UPGRADE_PROBE=0\.2\.0/);
    const changedManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    assert.equal(changedManifest.dependencies['dsh-p2p-collab'], 'file:' + join(result.backup, 'new-package.tgz'));
    assert.equal(changedManifest.dependencies['dsh-unrelated-upgrade-fixture'], manifest.dependencies['dsh-unrelated-upgrade-fixture']);
    assert.equal(hash(join(profileDir, 'node_modules/dsh-unrelated-upgrade-fixture/index.js')), hash(join(unrelated, 'index.js')));
    assert.equal(readFileSync(f.profilePath, 'utf8'), initialProfile);
    assert.equal(hash(join(profileDir, 'cordis.patch.yml')), patchHash);
    assert.ok(existsSync(join(profileDir, 'pnpm-lock.yaml')));
    await t.test('partial official rollback failure restores verified new code and keeps the new scheduler intact', async () => {
      const identity = checkPluginUpgrade(options, { processes: stopped }).identity;
      let failed = false;
      await assert.rejects(rollbackPlugin(options, result.backup, { offline: true, processes: stopped, packageOperation: async (value: any, archive: string) => {
        const installed = await installer!.installProfileArchive(value, archive);
        if (!failed && archive.endsWith('old-package.tgz')) { failed = true; throw new Error('Injected failure after old package files and manifest changed'); }
        return installed;
      } }), /Injected failure/);
      assert.equal(failed, true);
      const journal = JSON.parse(readFileSync(join(result.backup, 'plugin-upgrade.json'), 'utf8'));
      assert.equal(journal.phase, 'committed'); assert.equal(journal.lastRollbackAttempt.status, 'failed-new-code-restored');
      assert.deepEqual(checkPluginUpgrade(options, { processes: stopped }).identity, identity);
      assert.match(load(), /UPGRADE_PROBE=0\.2\.0/);
    });
    await rollbackPlugin(options, result.backup, { offline: true, processes: stopped });
    assert.match(load(), /UPGRADE_PROBE=0\.1\.5/);
    assert.equal(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies['dsh-p2p-collab'], 'file:' + join(result.backup, 'old-package.tgz'));
    assert.equal(hash(join(packageRuntime, 'package.json')), appPackageHash);
    assert.equal(hash(join(profileDir, 'cordis.patch.yml')), patchHash);
    await t.test('failed recovery after a partial package rollback records a blocking review phase', async () => {
      const upgraded = await installPlugin(options, { offline: true, processes: stopped });
      await assert.rejects(rollbackPlugin(options, upgraded.backup, { offline: true, processes: stopped, packageOperation: async (value: any, archive: string) => {
        if (archive.endsWith('new-package.tgz')) throw new Error('Injected recovery unavailable');
        await installer!.installProfileArchive(value, archive); throw new Error('Injected partial package failure');
      } }), /Injected partial/);
      const journal = JSON.parse(readFileSync(join(upgraded.backup, 'plugin-upgrade.json'), 'utf8'));
      assert.equal(journal.phase, 'rollback-failed-review-profile'); assert.equal(journal.lastRollbackAttempt.status, 'recovery-required');
      await assert.rejects(rollbackPlugin(options, upgraded.backup, { offline: true, processes: stopped }), /journal or retained archives/);
    });
  } finally { f.close(); }
});

const realPluginArchive = process.env.DSH_COLLAB_PLUGIN_ARCHIVE ?? resolve(project, '../releases/collab-conversation-20261005/plugin/dsh-p2p-collab-0.2.0.tgz');
const realOldPluginArchive = process.env.DSH_COLLAB_OLD_PLUGIN_ARCHIVE ?? resolve(project, '../releases/collab-live-update-20261003/plugin/dsh-p2p-collab-0.1.4.tgz');
for (const activation of ['bundle', 'profile-patch', 'no-user-patch']) {
test(`frozen actual 0.1.4 upgrades to 0.2.0, survives official reinstall and rolls back without resetting identity (${activation})`, {
  skip: installer && existsSync(realPluginArchive) && existsSync(realOldPluginArchive) && existsSync(join(packageRuntime, 'package-manager/node_modules/pnpm/bin/pnpm.mjs')) ? false : 'Requires reviewed 0.1.4 and 0.2.0 archives and the existing desktop runtime',
}, async () => {
  const f = pluginFixture();
  try {
    const archiveEntries = execFileSync('tar', ['-tzf', realPluginArchive], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(archiveEntries.every(path => /^package\/(?:package\.json|index\.js|client\.js|cordis\.patch\.yml)?$/.test(path)), 'Only the reviewed plugin bundle is extracted');
    execFileSync('tar', ['-xzf', realPluginArchive, '-C', f.options.packageDir, '--strip-components=1']);
    assert.equal(inspectBundle(f.options.packageDir).version, '0.2.0');
    const oldEntries = execFileSync('tar', ['-tzf', realOldPluginArchive], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(oldEntries.every(path => /^package\/(?:package\.json|index\.js|client\.js|cordis\.patch\.yml)?$/.test(path)), 'Only the retained 0.1.4 bundle is extracted');
    execFileSync('tar', ['-xzf', realOldPluginArchive, '-C', f.targets[0], '--strip-components=1']);
    const oldBundle = inspectBundle(f.targets[0]); assert.equal(oldBundle.version, '0.1.4');
    const profileDir = join(f.dir, 'profile'); mkdirSync(profileDir); mkdirSync(join(profileDir, 'node_modules'));
    cpSync(f.targets[0], join(profileDir, 'node_modules/dsh-p2p-collab'), { recursive: true });
    const selectedBundles = activation === 'profile-patch' ? [] : ['dsh-p2p-collab'];
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'real-plugin-upgrade-fixture', version: '1.0.0', private: true, type: 'module', dependencies: { 'dsh-p2p-collab': 'file:' + f.targets[0] }, dsh: { profile: { bundles: selectedBundles } } }));
    const patchPath = join(profileDir, 'cordis.patch.yml');
    if (activation !== 'no-user-patch') writeFileSync(patchPath, activation === 'profile-patch' ? '- insert:\n    - id: p2p-collab\n      name: dsh-p2p-collab\n' : '[]\n');
    const patchBefore = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : null;
    writeFileSync(join(profileDir, '.desktop.cordis.yml'), '[]\n');
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), JSON.stringify({ packages: [], offline: true, ignoreScripts: true, storeDir: join(f.dir, 'store'), cacheDir: join(f.dir, 'cache'), managePackageManagerVersions: false, updateNotifier: false }));
    writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, runs: {}, attempts: {}, settings: { maxTokens: 1000, maxMinutes: 10, publishMode: 'review', executionMode: 'manual' } }));
    const options = { ...f.options, runtimeRoot: packageRuntime, profileDir };
    const identityBefore = checkPluginUpgrade(options, { processes: stopped }).identity;
    const result = await installPlugin(options, { offline: true, processes: stopped });
    const reinstalled = await officialReinstall(options, true);
    assert.equal(reinstalled.exitCode, 0, 'Official reinstall uses the retained new archive');
    assert.equal(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies['dsh-p2p-collab'], 'file:' + join(result.backup, 'new-package.tgz'));
    assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles, selectedBundles);
    assert.equal(existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : null, patchBefore);
    const code = `import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
      const runtime=${JSON.stringify(packageRuntime)}, dir=${JSON.stringify(profileDir)}, home=${JSON.stringify(f.options.stateHome)};
      process.env.DSH_HOME=home; process.env.DSH_DESKTOP_STATE_HOME=home; process.env.DSH_DESKTOP_RUNTIME_ROOT=runtime; process.env.DSH_TELEMETRY_DISABLED='1';
      const require=createRequire(runtime+'/package.json');
      const {boot,loadProfileDirectory,readProfilePatches,createRuntimeResolution,PluginPackages}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
      const profile=loadProfileDirectory('upgrade-test',dir,runtime+'/package.json');
      const pc={name:'test',dir,patchPath:profile.patchPath,installAnchor:runtime+'/package.json',startedBundles:profile.layers.map(l=>l.packageName),cwd:home,home,overlays:[]};
      const resolution=await createRuntimeResolution({installAnchor:pc.installAnchor,profile,home}); let handler;
      const ctx=await boot('upgrade-test',dir+'/.desktop.cordis.yml',readProfilePatches('upgrade-test',pc,profile),async host=>{
        host.provide('profileContext',pc); await host.plugin(PluginPackages,{resolution});
        host.provide('connection',{rpc:{handle(channel,callback){if(channel==='/desktop-collab')handler=callback;return ()=>{};}}});
        host.provide('sessionController',{}); host.provide('sessionPersistence',{flush:async()=>{},list:async()=>[]});host.provide('agents',{get:()=>undefined});
        host.provide('desktopCollabBroker',{isRegistered:()=>false,grant:async()=>{throw new Error('offline fixture');}});
      });
      for(let i=0;!handler&&i<100;i++)await new Promise(r=>setTimeout(r,10));
      if(!handler)throw new Error('Actual plugin did not activate');
      const result=await handler('identity',{args:{}},new AbortController().signal);
      console.log('ACTUAL_PLUGIN='+JSON.stringify({ok:result.ok,version:result.value?.pluginVersion,peerId:result.value?.localPeerId}));await ctx.fiber.dispose();`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const actual = JSON.parse(output.match(/ACTUAL_PLUGIN=(.+)/)![1]);
    assert.deepEqual(actual, { ok: true, version: '0.2.0', peerId: f.profile.peerId });
    assert.deepEqual(checkPluginUpgrade(options, { processes: stopped }).identity, identityBefore);
    await rollbackPlugin(options, result.backup, { offline: true, processes: stopped });
    assert.deepEqual(inspectBundle(join(profileDir, 'node_modules/dsh-p2p-collab')), oldBundle);
    assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles, selectedBundles);
    assert.equal(existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : null, patchBefore);
  } finally { f.close(); }
});
}
