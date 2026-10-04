import Database from 'better-sqlite3';
import { chmodSync, closeSync, createReadStream, fsyncSync, mkdirSync, openSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { idField, textField } from './collab-types.js';

export type IdentityRepairRequest = {
  privateDbPath: string; collabDbPath: string; peerId: string; expectedOldDeviceId: string; newDeviceId: string;
  expectedDeviceName?: string; apply?: boolean; backupDirectory?: string; reason?: string;
};
type Peer = { id: string; device: string; nickname: string; banned: number };
type RepairAudit = { version: 1; requestId: string; peerId: string; expectedOldDeviceId: string; newDeviceId: string; expectedDeviceName?: string; backupDirectory: string };
export type IdentityRepairResult = {
  status: 'ready' | 'blocked' | 'applied' | 'already-applied'; peerId: string; expectedOldDeviceId: string; newDeviceId: string;
  currentDeviceId?: string; nickname?: string; issues: string[]; backupDirectory?: string; requestId?: string;
};
const action = 'repair-peer-device';

function existingDatabase(path: string): string {
  if (!path || !isAbsolute(path)) throw new Error('Database paths must be existing absolute files.');
  const resolved = realpathSync(path);
  if (!statSync(resolved).isFile()) throw new Error('Database path is not a regular file.');
  return resolved;
}
function openDatabase(path: string, readonly: boolean) {
  const db = new Database(path, { readonly, fileMustExist: true });
  db.pragma('busy_timeout = 5000'); db.pragma('foreign_keys = ON');
  return db;
}
function verified(db: Database.Database, label: string) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error(label + ' integrity check failed.');
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error(label + ' foreign key check failed.');
}
function priorRepair(db: Database.Database, request: IdentityRepairRequest): RepairAudit | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'collab_admin_log'").get()) return;
  const rows = db.prepare('SELECT reason FROM collab_admin_log WHERE action = ? AND target = ? ORDER BY id DESC').iterate(action, request.peerId) as Iterable<{ reason: string }>;
  for (const row of rows) {
    try {
      const audit = JSON.parse(row.reason) as RepairAudit;
      if (audit.version === 1 && audit.peerId === request.peerId && audit.expectedOldDeviceId === request.expectedOldDeviceId && audit.newDeviceId === request.newDeviceId && typeof audit.backupDirectory === 'string' && typeof audit.requestId === 'string') return audit;
    } catch { /* Existing moderation reasons need not be JSON. */ }
  }
}
function inspect(privateDb: Database.Database, collabDb: Database.Database, request: IdentityRepairRequest): IdentityRepairResult {
  verified(privateDb, 'Private database'); verified(collabDb, 'Collaboration database');
  const peer = collabDb.prepare('SELECT id, device, nickname, banned FROM collab_peers WHERE id = ?').get(request.peerId) as Peer | undefined;
  const issues: string[] = [];
  if (!peer) issues.push('Peer does not exist.');
  if (peer && peer.banned !== 0) issues.push('Peer is banned.');
  if (privateDb.prepare('SELECT 1 FROM remote_devices WHERE id = ?').get(request.expectedOldDeviceId)) issues.push('Expected old device is still registered.');
  if (!privateDb.prepare('SELECT 1 FROM remote_devices WHERE id = ?').get(request.newDeviceId)) issues.push('New device is not registered.');
  if (request.expectedDeviceName !== undefined) {
    const named = privateDb.prepare('SELECT id FROM remote_devices WHERE name = ?').all(request.expectedDeviceName) as { id: string }[];
    if (named.length !== 1 || named[0].id !== request.newDeviceId) issues.push('Expected device name must uniquely identify the new registered device.');
  }
  if (collabDb.prepare('SELECT 1 FROM collab_peers WHERE device = ? AND id <> ?').get(request.newDeviceId, request.peerId)) issues.push('New device is occupied by another peer.');
  const prior = peer?.device === request.newDeviceId ? priorRepair(collabDb, request) : undefined;
  if (peer && peer.device !== request.expectedOldDeviceId && !prior) issues.push('Peer device differs from the expected old device without a matching committed repair.');
  return { status: issues.length ? 'blocked' : prior ? 'already-applied' : 'ready', peerId: request.peerId, expectedOldDeviceId: request.expectedOldDeviceId,
    newDeviceId: request.newDeviceId, ...(peer ? { currentDeviceId: peer.device, nickname: peer.nickname } : {}), issues,
    ...(prior ? { requestId: prior.requestId, backupDirectory: prior.backupDirectory } : {}) };
}
function durableFile(path: string, body: string) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
async function backupDatabase(source: string, output: string) {
  // A separate reader can back up committed WAL pages while our writer holds BEGIN IMMEDIATE.
  const fd = openSync(output, 'wx', 0o600);
  closeSync(fd);
  const reader = openDatabase(source, true);
  try { await reader.backup(output); } finally { reader.close(); }
  chmodSync(output, 0o600);
  const backup = openDatabase(output, true);
  try { verified(backup, 'Backup'); } finally { backup.close(); }
  const handle = openSync(output, 'r');
  try { fsyncSync(handle); } finally { closeSync(handle); }
  if ((statSync(output).mode & 0o777) !== 0o600) throw new Error('Backup permissions are not 0600.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(output)) hash.update(chunk);
  return { path: output, bytes: statSync(output).size, sha256: hash.digest('hex') };
}

/** Offline administrator proof is explicit IDs, never a matching display name. No store constructor or schema migration runs. */
export async function repairCollabIdentity(request: IdentityRepairRequest): Promise<IdentityRepairResult> {
  idField(request.peerId); idField(request.expectedOldDeviceId); idField(request.newDeviceId);
  if (request.expectedOldDeviceId === request.newDeviceId) throw new Error('Old and new device IDs must differ.');
  if (request.expectedDeviceName !== undefined) textField(request.expectedDeviceName, 160);
  const privatePath = existingDatabase(request.privateDbPath), collabPath = existingDatabase(request.collabDbPath);
  const privateStat = statSync(privatePath), collabStat = statSync(collabPath);
  if (privateStat.dev === collabStat.dev && privateStat.ino === collabStat.ino) throw new Error('Private and collaboration databases must be distinct files.');
  if (request.apply) {
    if (!request.backupDirectory || !isAbsolute(request.backupDirectory)) throw new Error('Apply requires a new absolute backup directory.');
    textField(request.reason, 1000);
  }
  const privateDb = openDatabase(privatePath, !request.apply);
  let collabDb: Database.Database | undefined;
  try {
    // Match the administrator repair lock order; no private data is ever modified.
    if (request.apply) privateDb.exec('BEGIN IMMEDIATE');
    collabDb = openDatabase(collabPath, !request.apply);
    if (request.apply) collabDb.exec('BEGIN IMMEDIATE');
    const result = inspect(privateDb, collabDb, request);
    if (!request.apply || result.status === 'already-applied') return result;
    if (result.issues.length) throw new Error('Identity repair refused: ' + result.issues.join(' '));
    const directory = request.backupDirectory!;
    mkdirSync(directory, { mode: 0o700 }); // Never reuse or overwrite a previous attempt's backup.
    chmodSync(directory, 0o700);
    const backups = [];
    backups.push(await backupDatabase(privatePath, join(directory, 'private.sqlite')));
    backups.push(await backupDatabase(collabPath, join(directory, 'collaboration.sqlite')));
    const audit: RepairAudit = { version: 1, requestId: randomUUID(), peerId: request.peerId, expectedOldDeviceId: request.expectedOldDeviceId,
      newDeviceId: request.newDeviceId, ...(request.expectedDeviceName === undefined ? {} : { expectedDeviceName: request.expectedDeviceName }), backupDirectory: directory };
    const at = Date.now(), reason = JSON.stringify({ ...audit, reason: request.reason, at, databases: { private: privatePath, collaboration: collabPath }, backups });
    durableFile(join(directory, 'intent.json'), reason + '\n'); syncDirectory(directory); syncDirectory(dirname(directory));
    collabDb.exec('CREATE TABLE IF NOT EXISTS collab_admin_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL)');
    collabDb.prepare('INSERT INTO collab_admin_log(action, target, reason, at) VALUES (?, ?, ?, ?)').run(action, request.peerId, reason, at);
    const updated = collabDb.prepare('UPDATE collab_peers SET device = ? WHERE id = ? AND device = ? AND banned = 0 AND nickname = ?').run(request.newDeviceId, request.peerId, request.expectedOldDeviceId, result.nickname);
    if (updated.changes !== 1) throw new Error('Identity changed during repair; no changes committed.');
    verified(collabDb, 'Repaired collaboration database');
    collabDb.exec('COMMIT');
    return { ...result, status: 'applied', currentDeviceId: request.newDeviceId, backupDirectory: directory, requestId: audit.requestId };
  } finally {
    if (collabDb?.inTransaction) collabDb.exec('ROLLBACK');
    collabDb?.close();
    if (privateDb.inTransaction) privateDb.exec('ROLLBACK');
    privateDb.close();
  }
}
