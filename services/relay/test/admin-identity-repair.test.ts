import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairCollabIdentity, type IdentityRepairRequest } from '../src/collab-identity-repair.js';

const oldDevice = 'old-device-fixture', newDevice = 'new-device-fixture';
function fixture(recovery = false, wal = false) {
  const dir = mkdtempSync(join(tmpdir(), 'collab-identity-repair-'));
  const privateDbPath = join(dir, 'private.sqlite'), collabDbPath = join(dir, 'collaboration.sqlite');
  const privateDb = new Database(privateDbPath), collabDb = new Database(collabDbPath);
  if (wal) for (const db of [privateDb, collabDb]) { db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0'); }
  privateDb.exec('CREATE TABLE remote_devices (id TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL, token TEXT NOT NULL)');
  privateDb.prepare('INSERT INTO remote_devices VALUES (?, ?, ?, ?)').run(newDevice, 'owner@example.test', 'New desktop', 'private-token-hash');
  collabDb.exec(`
    CREATE TABLE collab_peers (id TEXT PRIMARY KEY, device TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, createdAt INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0${recovery ? ', recoveryHash TEXT' : ''});
    CREATE TABLE collab_tasks (id TEXT PRIMARY KEY, authorId TEXT NOT NULL REFERENCES collab_peers(id), content TEXT NOT NULL);
    CREATE TABLE collab_replies (id TEXT PRIMARY KEY, authorId TEXT NOT NULL REFERENCES collab_peers(id), taskId TEXT NOT NULL REFERENCES collab_tasks(id), body TEXT NOT NULL);
    CREATE TABLE collab_attachments (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES collab_peers(id), data BLOB NOT NULL);
    CREATE TABLE collab_inbox (peerId TEXT NOT NULL REFERENCES collab_peers(id), eventId INTEGER NOT NULL, read INTEGER NOT NULL);
  `);
  const peerId = randomUUID();
  collabDb.prepare('INSERT INTO collab_peers (id, device, nickname, createdAt) VALUES (?, ?, ?, ?)').run(peerId, oldDevice, 'Same display name', 123);
  if (recovery) collabDb.prepare('UPDATE collab_peers SET recoveryHash = ?').run('existing-recovery-hash');
  collabDb.prepare('INSERT INTO collab_tasks VALUES (?, ?, ?)').run('task-fixture', peerId, 'Original history');
  collabDb.prepare('INSERT INTO collab_replies VALUES (?, ?, ?, ?)').run('reply-fixture', peerId, 'task-fixture', 'Original solution');
  collabDb.prepare('INSERT INTO collab_attachments VALUES (?, ?, ?)').run('file-fixture', peerId, Buffer.from('Original attachment\0bytes'));
  collabDb.prepare('INSERT INTO collab_inbox VALUES (?, ?, ?)').run(peerId, 42, 0);
  const request: IdentityRepairRequest = { privateDbPath, collabDbPath, peerId, expectedOldDeviceId: oldDevice, newDeviceId: newDevice, expectedDeviceName: 'New desktop' };
  return { dir, privateDb, collabDb, request,
    apply: () => ({ ...request, apply: true, backupDirectory: join(dir, 'backup'), reason: 'Owner verified the old and new registrations' }),
    close: () => { privateDb.close(); collabDb.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const peer = (db: Database.Database) => db.prepare('SELECT * FROM collab_peers ORDER BY id').all() as any[];
function history(db: Database.Database) {
  return ['collab_tasks', 'collab_replies', 'collab_attachments', 'collab_inbox'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
}

test('default diagnosis and CLI dry-run do not change a legacy schema, database bytes or create backups', async () => {
  const f = fixture();
  try {
    const before = [digest(f.request.privateDbPath), digest(f.request.collabDbPath)];
    const result = await repairCollabIdentity(f.request);
    assert.equal(result.status, 'ready');
    const cli = fileURLToPath(new URL('../src/collab-admin.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [tsx, cli, 'repair-identity', f.request.peerId, oldDevice, newDevice, '--dry-run'], {
      env: { ...process.env, DB_PATH: f.request.privateDbPath, COLLAB_DB_PATH: f.request.collabDbPath }, encoding: 'utf8' });
    assert.equal(JSON.parse(output).status, 'ready');
    assert.equal(output.includes('private-token-hash'), false);
    assert.deepEqual([digest(f.request.privateDbPath), digest(f.request.collabDbPath)], before);
    assert.deepEqual(readdirSync(f.dir).sort(), ['collaboration.sqlite', 'private.sqlite']);
    assert.equal((f.collabDb.pragma('table_info(collab_peers)') as any[]).some(row => row.name === 'recoveryHash'), false);
  } finally { f.close(); }
});

test('apply locks both databases, backs up committed WAL and changes only device plus its audit; retries are idempotent', async t => {
  const f = fixture(true, true), originalBackup = Database.prototype.backup;
  let observedLocks = false;
  t.mock.method(Database.prototype, 'backup', function(this: Database.Database, ...args: Parameters<Database.Database['backup']>) {
    if (!observedLocks) {
      for (const [path, query] of [[f.request.privateDbPath, "UPDATE remote_devices SET name = 'racing writer'"], [f.request.collabDbPath, "UPDATE collab_peers SET nickname = 'racing writer'"]]) {
        const racer = new Database(path); racer.pragma('busy_timeout = 0');
        try { assert.throws(() => racer.exec(query), /locked/); } finally { racer.close(); }
      }
      observedLocks = true;
    }
    return originalBackup.apply(this, args);
  });
  try {
    assert.ok(statSync(f.request.collabDbPath + '-wal').size > 0);
    const beforePeer = peer(f.collabDb), beforeHistory = history(f.collabDb), beforePrivate = f.privateDb.prepare('SELECT * FROM remote_devices').all();
    const result = await repairCollabIdentity(f.apply());
    assert.equal(result.status, 'applied'); assert.equal(observedLocks, true);
    assert.deepEqual(peer(f.collabDb), [{ ...beforePeer[0], device: newDevice }]);
    assert.deepEqual(history(f.collabDb), beforeHistory); assert.deepEqual(f.privateDb.prepare('SELECT * FROM remote_devices').all(), beforePrivate);
    for (const name of ['private.sqlite', 'collaboration.sqlite', 'intent.json']) assert.equal(statSync(join(result.backupDirectory!, name)).mode & 0o777, 0o600);
    const backup = new Database(join(result.backupDirectory!, 'collaboration.sqlite'), { readonly: true, fileMustExist: true });
    try { assert.deepEqual(peer(backup), beforePeer); assert.deepEqual(history(backup), beforeHistory); assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok'); } finally { backup.close(); }
    const audit = JSON.parse(readFileSync(join(result.backupDirectory!, 'intent.json'), 'utf8'));
    assert.equal(audit.requestId, result.requestId);
    for (const file of audit.backups) assert.equal(file.sha256, digest(file.path));
    const repeated = await repairCollabIdentity(f.apply());
    assert.equal(repeated.status, 'already-applied'); assert.equal(repeated.requestId, result.requestId);
    assert.equal((f.collabDb.prepare('SELECT count(*) AS n FROM collab_admin_log').get() as any).n, 1);
    assert.equal((await repairCollabIdentity(f.request)).status, 'already-applied');
  } finally { f.close(); }
});

test('legacy apply does not add recovery fields or alter historical rows', async () => {
  const f = fixture();
  try {
    const before = history(f.collabDb);
    assert.equal((await repairCollabIdentity(f.apply())).status, 'applied');
    assert.deepEqual(history(f.collabDb), before);
    assert.equal((f.collabDb.pragma('table_info(collab_peers)') as any[]).some(row => row.name === 'recoveryHash'), false);
  } finally { f.close(); }
});

test('identity guards reject name-only ownership, stale IDs, live old devices, occupied targets and bans', async t => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void, RegExp][] = [
    ['missing peer', f => { f.request.peerId = randomUUID(); }, /Peer does not exist/],
    ['wrong old device', f => { f.request.expectedOldDeviceId = 'unrelated-old-device'; }, /expected old device/],
    ['device name mismatch', f => { f.request.expectedDeviceName = 'Other name'; }, /device name/],
    ['duplicate device names', f => { f.privateDb.prepare('INSERT INTO remote_devices VALUES (?, ?, ?, ?)').run('other-device-fixture', 'owner@example.test', 'New desktop', 'hash'); }, /uniquely identify/],
    ['device name belongs to another ID', f => { f.privateDb.prepare('INSERT INTO remote_devices VALUES (?, ?, ?, ?)').run('other-device-fixture', 'owner@example.test', 'Other desktop', 'hash'); f.request.expectedDeviceName = 'Other desktop'; }, /uniquely identify/],
    ['old still registered', f => { f.privateDb.prepare('INSERT INTO remote_devices VALUES (?, ?, ?, ?)').run(oldDevice, 'owner@example.test', 'Same display name', 'hash'); }, /still registered/],
    ['new missing', f => { f.privateDb.prepare('DELETE FROM remote_devices').run(); }, /not registered/],
    ['new occupied', f => { f.collabDb.prepare('INSERT INTO collab_peers VALUES (?, ?, ?, ?, ?)').run(randomUUID(), newDevice, 'Same display name', 124, 0); }, /occupied/],
    ['banned', f => { f.collabDb.prepare('UPDATE collab_peers SET banned = 1').run(); }, /banned/],
    ['already new without audit', f => { f.collabDb.prepare('UPDATE collab_peers SET device = ?').run(newDevice); }, /without a matching committed repair/],
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, async () => {
    const f = fixture();
    try {
      mutate(f); const before = peer(f.collabDb);
      const diagnosis = await repairCollabIdentity(f.request); assert.equal(diagnosis.status, 'blocked'); assert.match(diagnosis.issues.join(' '), expected);
      await assert.rejects(repairCollabIdentity(f.apply()), expected);
      assert.deepEqual(peer(f.collabDb), before); assert.equal(existsSync(join(f.dir, 'backup')), false);
    } finally { f.close(); }
  });
});

test('missing files, same database, unchanged device IDs and invalid foreign keys fail closed', async () => {
  const f = fixture();
  try {
    const missing = join(f.dir, 'missing.sqlite');
    await assert.rejects(repairCollabIdentity({ ...f.request, privateDbPath: missing })); assert.equal(existsSync(missing), false);
    await assert.rejects(repairCollabIdentity({ ...f.request, privateDbPath: f.request.collabDbPath }), /distinct/);
    await assert.rejects(repairCollabIdentity({ ...f.request, newDeviceId: oldDevice }), /must differ/);
    f.collabDb.pragma('foreign_keys = OFF');
    f.collabDb.prepare('INSERT INTO collab_tasks VALUES (?, ?, ?)').run('orphan-task', 'missing-peer', 'bad reference');
    await assert.rejects(repairCollabIdentity(f.apply()), /foreign key/);
    assert.equal(peer(f.collabDb)[0].device, oldDevice); assert.equal(existsSync(join(f.dir, 'backup')), false);
  } finally { f.close(); }
});

test('backup failure or failure to persist intent rolls back and leaves the identity unchanged', async t => {
  for (const fault of ['backup', 'integrity', 'intent'] as const) await t.test(fault, async child => {
    const f = fixture(), originalBackup = Database.prototype.backup;
    let calls = 0;
    child.mock.method(Database.prototype, 'backup', async function(this: Database.Database, ...args: Parameters<Database.Database['backup']>) {
      calls++;
      if (calls === 2 && fault === 'backup') throw new Error('Injected backup failure');
      const result = await originalBackup.apply(this, args);
      if (calls === 2 && fault === 'integrity') {
        const damaged = new Database(args[0]);
        try { damaged.pragma('foreign_keys = OFF'); damaged.prepare('INSERT INTO collab_tasks VALUES (?, ?, ?)').run('orphan-backup', 'missing-peer', 'damaged backup'); } finally { damaged.close(); }
      }
      if (calls === 2 && fault === 'intent') mkdirSync(join(f.dir, 'backup', 'intent.json'));
      return result;
    });
    try {
      await assert.rejects(repairCollabIdentity(f.apply()), fault === 'backup' ? /Injected backup failure/ : fault === 'integrity' ? /Backup foreign key/ : /EEXIST/);
      assert.equal(peer(f.collabDb)[0].device, oldDevice);
      assert.equal(f.collabDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'collab_admin_log'").get(), undefined);
      f.privateDb.prepare("UPDATE remote_devices SET name = 'locks released'").run();
      f.collabDb.prepare("UPDATE collab_peers SET nickname = 'locks released'").run();
    } finally { f.close(); }
  });
});

test('a changed row at compare-and-swap rolls back both the update and audit while retaining verified backups and intent', async () => {
  const f = fixture();
  try {
    f.collabDb.exec(`CREATE TABLE collab_admin_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TRIGGER change_before_repair AFTER INSERT ON collab_admin_log BEGIN UPDATE collab_peers SET device = 'unexpected-device'; END;`);
    await assert.rejects(repairCollabIdentity(f.apply()), /Identity changed/);
    assert.equal(peer(f.collabDb)[0].device, oldDevice);
    assert.equal((f.collabDb.prepare('SELECT count(*) AS n FROM collab_admin_log').get() as any).n, 0);
    assert.ok(existsSync(join(f.dir, 'backup', 'intent.json')));
  } finally { f.close(); }
});
