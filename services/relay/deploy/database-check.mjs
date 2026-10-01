import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PrivateStore } from '../dist/private-store.js';

const tables = ['remote_accounts', 'remote_codes', 'remote_devices', 'remote_invites', 'remote_bindings'];
const identifier = value => {
  if (!/^[a-z_]+$/.test(value)) throw new Error('Unexpected database column');
  return `"${value}"`;
};

function snapshot(file, columns) {
  if (!statSync(file).isFile()) throw new Error('Existing database file required');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Database integrity check failed');
    const result = {};
    for (const table of tables) {
      const names = columns?.[table] ?? db.pragma(`table_info(${table})`).map(c => c.name);
      if (!names.length) throw new Error(`Missing private relay table: ${table}`);
      const fields = names.map(identifier).join(', '), digest = createHash('sha256');
      let count = 0;
      for (const row of db.prepare(`SELECT ${fields} FROM ${table} ORDER BY ${identifier(names[0])}`).iterate()) {
        digest.update(JSON.stringify(row) + '\n'); count++;
      }
      result[table] = { columns: names, count, sha256: digest.digest('hex') };
    }
    const relayId = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'remote_metadata'").get()
      ? db.prepare("SELECT value FROM remote_metadata WHERE key = 'relay_id'").get()?.value : undefined;
    return { tables: result, relayId };
  } finally { db.close(); }
}

/** Call only on a private COPY of the stopped service's database and WAL/SHM. */
export function verifyMigrationCopy(file) {
  const before = snapshot(file);
  const store = new PrivateStore(file); store.db.close();
  const after = snapshot(file, Object.fromEntries(Object.entries(before.tables).map(([name, value]) => [name, value.columns])));
  if (JSON.stringify(before.tables) !== JSON.stringify(after.tables) || (before.relayId && before.relayId !== after.relayId)) {
    throw new Error('Migration changed existing registration or binding data');
  }
  return { existingRowsPreserved: true, tables: before.tables, relayId: after.relayId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [action, file] = process.argv.slice(2);
    if (action === 'verify-copy') console.log(JSON.stringify(verifyMigrationCopy(file)));
    else if (action === 'runtime') {
      new Database(':memory:').close(); await import('../dist/private-server.js');
      console.log(JSON.stringify({ runtimeReady: true }));
    } else if (action === 'identity') {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try { console.log(JSON.stringify({ relayId: db.prepare("SELECT value FROM remote_metadata WHERE key = 'relay_id'").get()?.value })); }
      finally { db.close(); }
    } else throw new Error('Use runtime, verify-copy <database-copy>, or identity <database>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
