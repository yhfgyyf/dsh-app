import Database from 'better-sqlite3';
import { existsSync, mkdirSync, chmodSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { idField, textField } from './collab-types.js';
import { repairCollabIdentity } from './collab-identity-repair.js';

process.umask(0o077);
const [action, ...args] = process.argv.slice(2);
const path = process.env.COLLAB_DB_PATH;
if (!path || !isAbsolute(path) || !existsSync(path)) throw new Error('Set COLLAB_DB_PATH to the existing absolute collaboration database path.');
if (!['backup', 'hide-task', 'show-task', 'ban-peer', 'unban-peer', 'diagnose-identity', 'repair-identity'].includes(action)) throw new Error('Usage: collab-admin backup <new-absolute-file> | hide-task|show-task|ban-peer|unban-peer <id> <reason> | diagnose-identity|repair-identity <peerId> <expectedOldDeviceId> <newDeviceId> [--expected-device-name <unique-registered-device-name>] [--dry-run | --apply --backup-dir <new-absolute-directory> --reason <reason>]; identity commands also require DB_PATH. Device name is only an extra guard, never ownership proof.');
if (action === 'diagnose-identity' || action === 'repair-identity') {
  const [peerId, expectedOldDeviceId, newDeviceId, ...options] = args;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (!['--expected-device-name', '--apply', '--dry-run', '--backup-dir', '--reason'].includes(option) || flags.has(option)) throw new Error('Unknown or repeated identity repair option: ' + option);
    if (option === '--apply' || option === '--dry-run') flags.set(option, true);
    else { const value = options[++i]; if (!value || value.startsWith('--')) throw new Error('Missing value for ' + option); flags.set(option, value); }
  }
  if (flags.has('--apply') && (action === 'diagnose-identity' || flags.has('--dry-run'))) throw new Error('Apply cannot be combined with diagnosis or dry-run.');
  const result = await repairCollabIdentity({ privateDbPath: process.env.DB_PATH ?? '', collabDbPath: path, peerId, expectedOldDeviceId, newDeviceId,
    apply: flags.has('--apply'), expectedDeviceName: flags.get('--expected-device-name') as string | undefined,
    backupDirectory: flags.get('--backup-dir') as string | undefined, reason: flags.get('--reason') as string | undefined });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'blocked') process.exitCode = 1;
} else {
const db = new Database(path, { readonly: action === 'backup', fileMustExist: true });
db.pragma('busy_timeout = 5000');
try {
  if (action === 'backup') {
    const [output, ...extra] = args;
    if (!output || !isAbsolute(output) || extra.length || existsSync(output)) throw new Error('Backup requires a new absolute file; existing files are never replaced.');
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    const temporary = output + '.' + randomUUID() + '.partial';
    try {
      await db.backup(temporary);
      const backup = new Database(temporary, { readonly: true, fileMustExist: true });
      try { if (backup.pragma('integrity_check', { simple: true }) !== 'ok' || (backup.pragma('foreign_key_check') as unknown[]).length) throw new Error('Backup verification failed'); }
      finally { backup.close(); }
      chmodSync(temporary, 0o600); linkSync(temporary, output);
      console.log('Verified SQLite backup created, including attachments: ' + output);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  } else {
    const [target, reason, ...extra] = args;
    idField(target); textField(reason, 1000); if (extra.length) throw new Error('Unexpected arguments');
    db.transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS collab_admin_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL)');
      const task = action.endsWith('task'), enabled = action === 'hide-task' || action === 'ban-peer';
      const result = task ? db.prepare('UPDATE collab_tasks SET hidden = ? WHERE id = ?').run(enabled ? 1 : 0, target)
        : db.prepare('UPDATE collab_peers SET banned = ? WHERE id = ?').run(enabled ? 1 : 0, target);
      if (result.changes !== 1) throw new Error('Target does not exist');
      if (task) db.prepare('INSERT INTO collab_events(taskId, actorId, kind, at) SELECT id, authorId, ?, ? FROM collab_tasks WHERE id = ?').run(enabled ? 'task.hidden' : 'task.restored', Date.now(), target);
      db.prepare('INSERT INTO collab_admin_log(action, target, reason, at) VALUES (?, ?, ?, ?)').run(action, target, reason, Date.now());
    })();
    console.log('Applied ' + action + ' to ' + target + '; content retained.');
  }
} finally { db.close(); }
}
