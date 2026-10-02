import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { PrivateStore as LegacyStore } from './fixtures/relay-0.1.30/private-store.js';
import { applyUpgrade, checkUpgrade, rollbackUpgrade } from '../deploy/upgrade.mjs';
import { verifyMigrationCopy } from '../deploy/database-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = ['package.json', 'src/private-server.ts', 'src/private-store.ts', 'src/client-endpoints.ts',
  'src/collab-auth.ts', 'src/collab-types.ts', 'dist/collab-auth.js', 'dist/collab-types.js',
  'dist/private-server.js', 'dist/private-store.js', 'dist/client-endpoints.js', 'deploy/upgrade.mjs', 'deploy/database-check.mjs'];

async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-safe-upgrade-')));
  const paths = { packageDir: join(dir, 'package'), app: join(dir, 'opt/dsh-relay'), env: join(dir, 'etc/dsh-relay.env'),
    releases: join(dir, 'opt/dsh-relay-releases'), backups: join(dir, 'backups'), dropin: join(dir, 'etc/systemd/dsh-relay.service.d/90-dsh-relay-release.conf') };
  for (const path of [paths.packageDir, join(paths.app, 'dist'), dirname(paths.env), join(dir, 'data')]) mkdirSync(path, { recursive: true });
  for (const name of files) {
    mkdirSync(dirname(join(paths.packageDir, name)), { recursive: true }); copyFileSync(join(root, name), join(paths.packageDir, name));
  }
  for (const name of ['private-server.js', 'private-store.js']) copyFileSync(join(root, 'test/fixtures/relay-0.1.30', name), join(paths.app, 'dist', name));
  writeFileSync(join(paths.app, 'package.json'), '{"type":"module"}');
  for (const dest of [paths.app, paths.packageDir]) symlinkSync(join(root, 'node_modules'), join(dest, 'node_modules'), 'dir');
  function manifest() {
    writeFileSync(join(paths.packageDir, 'PACKAGE-MANIFEST.json'), JSON.stringify({ releaseVersion: 'upgrade-test.1', protocol: 'dsh-desktop-remote-v1',
      files: files.map(path => ({ path, sha256: sha(join(paths.packageDir, path)) })) }));
  }
  manifest();
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as any).port; await new Promise<void>(r => reservation.close(() => r()));
  const database = join(dir, 'data/existing.sqlite'), origin = `http://127.0.0.1:${port}`;
  writeFileSync(paths.env, `NODE_ENV=production\nHOST=127.0.0.1\nPORT=${port}\nDB_PATH=${database}\nPUBLIC_RELAY_URL=https://10.35.187.99:8443\nRELAY_CLIENT_ENDPOINTS='[{"origin":"https://10.80.0.9:8443","network":"private"}]'\n`);
  const protectedFiles = [paths.env, join(paths.app, 'ca.pem'), join(dir, 'etc/nginx.conf'), join(dir, 'etc/relay-key.pem')];
  for (const path of protectedFiles.slice(1)) writeFileSync(path, `Fixture only, preserve exact bytes: ${path}\n`);
  const protectedHashes = protectedFiles.map(sha), oldCodeHash = sha(join(paths.app, 'dist/private-server.js'));
  const store = new LegacyStore(database), password = 'fixture-long-password', account = 'upgrade@example.test';
  store.provision(account, password);
  const registered = store.register(store.registration(account), 'Existing desktop');
  const existingBinding = store.bind(registered.deviceId, 'Existing phone');
  const unusedCode = store.registration(account), invitation = store.invite(registered.deviceId, true);
  store.db.close();
  let child: ChildProcess | undefined, activeInfo: any, candidateHook: (() => Promise<void>) | undefined, diagnostics = '';
  let starts = 0, stops = 0;
  async function reachable() {
    for (let n = 0; n < 60; n++) {
      if (child?.exitCode !== null) throw new Error(`Fixture relay exited: ${diagnostics}`);
      try { if ((await fetch(origin + '/health')).status === 200) return; } catch {}
      await delay(25);
    }
    throw new Error(`Fixture relay failed to start: ${diagnostics}`);
  }
  const service = {
    inspect() {
      if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture service inactive');
      return { ...activeInfo, pid: child.pid };
    },
    configuration: () => '[Service]\nUser=dsh-relay\nWorkingDirectory=/opt/dsh-relay\nExecStart=/usr/bin/node dist/private-server.js\n',
    async stop() {
      stops++;
      const current = child; child = undefined;
      if (current && current.exitCode === null && current.signalCode === null) { current.kill('SIGTERM'); await once(current, 'exit'); }
    },
    reload() {},
    async start() {
      starts++;
      const override = existsSync(paths.dropin) ? readFileSync(paths.dropin, 'utf8') : '';
      const match = override.match(/^ExecStart="([^"]+)" "([^"]+)"$/m);
      const entry = match?.[2] ?? join(paths.app, 'dist/private-server.js');
      const env = parseEnv(readFileSync(paths.env, 'utf8'));
      activeInfo = { cwd: paths.app, node: process.execPath, entry, env, user: 'fixture' };
      diagnostics = '';
      child = spawn(process.execPath, [entry], { cwd: paths.app, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr!.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
      await reachable();
      if (match && candidateHook) { const hook = candidateHook; candidateHook = undefined; await hook(); }
    },
    asUser(info: any, args: string[]) { return execFileSync(info.node, args, { encoding: 'utf8' }); },
  };
  const post = async (path: string, body: object, token?: string) => {
    const response = await fetch(origin + '/v1/' + path, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try { await service.start(); } catch (error) { await service.stop(); rmSync(dir, { recursive: true, force: true }); throw error; }
  return { paths, service, database, origin, manifest, post, registered, existingBinding, unusedCode, invitation, account, password,
    setCandidateHook: (hook: () => Promise<void>) => { candidateHook = hook; },
    counts: () => ({ starts, stops }),
    preserved() {
      assert.deepEqual(protectedFiles.map(sha), protectedHashes, 'Environment, proxy, CA and key files must remain byte-identical');
      assert.equal(sha(join(paths.app, 'dist/private-server.js')), oldCodeHash, 'Original server code must stay in place');
    },
    async close() { await service.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('upgrade preserves old account, unused registration, invite and binding; rollback keeps registrations created after upgrade', async () => {
  const f = await fixture();
  try {
    const checked = await checkUpgrade(f.paths, f.service);
    assert.equal(checked.config.DB_PATH, f.database);
    assert.equal(f.counts().stops, 0);
    const result = await applyUpgrade(f.paths, f.service, () => {});
    const state = JSON.parse(readFileSync(join(result.backup, 'upgrade-state.json'), 'utf8'));
    assert.equal(state.phase, 'committed');
    assert.equal(state.migration.existingRowsPreserved, true);
    assert.equal(state.migration.tables.remote_accounts.count, 1);
    assert.equal(state.migration.tables.remote_codes.count, 1);
    assert.equal(state.migration.tables.remote_devices.count, 1);
    assert.equal(state.migration.tables.remote_invites.count, 1);
    assert.equal(state.migration.tables.remote_bindings.count, 1);
    assert.equal((await f.post('login', { email: f.account, password: f.password })).status, 200);
    assert.equal((await f.post('status', { bindingId: f.existingBinding.bindingId }, f.existingBinding.bindingToken)).body.state, 'approved');
    const newDevice = await f.post('register', { code: f.unusedCode, name: 'Registered after upgrade' });
    assert.equal(newDevice.status, 201);
    assert.equal(newDevice.body.relayRoutes.endpoints[0].origin, 'https://10.80.0.9:8443');
    const newBinding = await f.post('bind', { deviceId: newDevice.body.deviceId, name: 'New phone' }, newDevice.body.deviceToken);
    assert.equal(newBinding.status, 201);
    assert.equal((await f.post('claim-qr', { ...f.invitation, name: 'Preserved invitation' })).status, 201);
    await rollbackUpgrade(f.paths, f.service, result.backup);
    assert.equal((await f.post('status', { bindingId: f.existingBinding.bindingId }, f.existingBinding.bindingToken)).body.state, 'approved');
    assert.equal((await f.post('status', { bindingId: newBinding.body.bindingId }, newBinding.body.bindingToken)).body.state, 'approved');
    assert.equal((await f.post('bindings', { deviceId: newDevice.body.deviceId }, newDevice.body.deviceToken)).status, 200);
    assert.equal((await f.post('login', { email: f.account, password: f.password })).status, 200);
    assert.equal((await (await fetch(f.origin + '/health')).json() as any).relayId, undefined, 'The real previous relay code is running again');
    f.preserved();
  } finally { await f.close(); }
});

test('a post-start error automatically restores old code without discarding a newly accepted binding', async () => {
  const f = await fixture(), logs: string[] = [];
  let newBinding: any;
  try {
    f.setCandidateHook(async () => {
      newBinding = await f.post('bind', { deviceId: f.registered.deviceId, name: 'Created before failure' }, f.registered.deviceToken);
      assert.equal(newBinding.status, 201);
      throw new Error('Injected upgrade failure after new server accepted a write');
    });
    await assert.rejects(applyUpgrade(f.paths, f.service, line => logs.push(line)), /Injected upgrade failure/);
    assert.ok(logs.some(line => line.startsWith('ROLLBACK_OK:')));
    assert.equal((await f.post('status', { bindingId: newBinding.body.bindingId }, newBinding.body.bindingToken)).body.state, 'approved');
    assert.equal((await f.post('status', { bindingId: f.existingBinding.bindingId }, f.existingBinding.bindingToken)).body.state, 'approved');
    f.preserved();
  } finally { await f.close(); }
});

test('a wrong health response triggers automatic rollback to the actual old server', async () => {
  const f = await fixture(), logs: string[] = [];
  try {
    const file = join(f.paths.packageDir, 'dist/private-server.js'), original = readFileSync(file, 'utf8');
    assert.match(original, /ok: true, relayId:/);
    writeFileSync(file, original.replace('ok: true, relayId:', 'ok: false, relayId:')); f.manifest();
    await assert.rejects(applyUpgrade(f.paths, f.service, line => logs.push(line)), /stable process\/database\/health/);
    assert.ok(logs.some(line => line.startsWith('ROLLBACK_OK:')));
    assert.equal((await f.post('status', { bindingId: f.existingBinding.bindingId }, f.existingBinding.bindingToken)).status, 200);
    f.preserved();
  } finally { await f.close(); }
});

test('missing database, changed package and mismatched active configuration fail before stopping the old service', async () => {
  const f = await fixture();
  try {
    const original = readFileSync(f.paths.env, 'utf8');
    writeFileSync(f.paths.env, original.replace(f.database, f.database + '.missing'));
    await assert.rejects(checkUpgrade(f.paths, f.service), /EXISTING absolute database/);
    writeFileSync(f.paths.env, original.replace('PORT=', 'PORT=1'));
    await assert.rejects(checkUpgrade(f.paths, f.service));
    writeFileSync(f.paths.env, original.replace('RELAY_CLIENT_ENDPOINTS=', 'export RELAY_CLIENT_ENDPOINTS='));
    await assert.rejects(checkUpgrade(f.paths, f.service), /shell export keyword/);
    writeFileSync(f.paths.env, original);
    mkdirSync(dirname(f.paths.dropin), { recursive: true }); writeFileSync(f.paths.dropin, '# Existing administrator configuration\n');
    await assert.rejects(checkUpgrade(f.paths, f.service), /unrelated configuration/);
    unlinkSync(f.paths.dropin);
    writeFileSync(join(f.paths.packageDir, 'dist/client-endpoints.js'), '// accidental incomplete copy\n');
    await assert.rejects(applyUpgrade(f.paths, f.service, () => {}), /checksum mismatch/);
    assert.equal(f.counts().stops, 0);
    assert.equal((await f.post('status', { bindingId: f.existingBinding.bindingId }, f.existingBinding.bindingToken)).status, 200);
    f.preserved();
  } finally { await f.close(); }
});

test('an older rollback journal cannot replace a later deployment override', async () => {
  const f = await fixture();
  try {
    const first = await applyUpgrade(f.paths, f.service, () => {});
    const second = await applyUpgrade(f.paths, f.service, () => {});
    const before = f.counts().stops;
    await assert.rejects(rollbackUpgrade(f.paths, f.service, first.backup), /later deployment/);
    assert.equal(f.counts().stops, before);
    await rollbackUpgrade(f.paths, f.service, second.backup);
    await rollbackUpgrade(f.paths, f.service, first.backup);
    f.preserved();
  } finally { await f.close(); }
});

test('migration validation includes committed records still in the copied WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wal-upgrade-')), file = join(dir, 'live.sqlite');
  const store = new LegacyStore(file);
  try {
    store.db.pragma('wal_autocheckpoint = 0');
    store.provision('wal@example.test', 'test-long-password');
    const device = store.register(store.registration('wal@example.test'), 'WAL desktop');
    store.bind(device.deviceId, 'WAL phone');
    const copy = join(dir, 'copy.sqlite');
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
    const verified = verifyMigrationCopy(copy);
    assert.equal(verified.tables.remote_accounts.count, 1);
    assert.equal(verified.tables.remote_devices.count, 1);
    assert.equal(verified.tables.remote_bindings.count, 1);
    assert.equal(verified.existingRowsPreserved, true);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
