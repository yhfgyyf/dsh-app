const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const Database = require('../patches/univer-office-kylin/sqlite.cjs');

test('Univer SQLite preserves transactions, savepoints, blobs and read-only files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'univer-kylin-sqlite-'));
  const file = join(directory, 'sample.univer');
  let db;
  try {
    db = new Database(file);
    db.exec('PRAGMA foreign_keys = ON; CREATE TABLE item (id TEXT PRIMARY KEY, value BLOB) STRICT;');
    const insert = db.prepare('INSERT INTO item VALUES (?, ?)');
    assert.equal(db.inTransaction, false);
    db.exec('BEGIN IMMEDIATE;');
    assert.equal(db.inTransaction, true);
    assert.equal(insert.run('kept', Buffer.from([0, 128, 255])).changes, 1);
    db.exec('SAVEPOINT inner_transaction;');
    insert.run('rolled-back', null);
    db.exec('ROLLBACK TO inner_transaction; RELEASE inner_transaction; COMMIT;');
    assert.equal(db.inTransaction, false);
    assert.equal(db.prepare('SELECT * FROM item WHERE id = ?').get('rolled-back'), undefined);
    assert.throws(() => insert.run('kept', null), /UNIQUE constraint failed/);
    assert.equal(db.inTransaction, false);
    db.exec('BEGIN IMMEDIATE;');
    insert.run('outer-rollback', null);
    db.exec('ROLLBACK;');
    db.close();
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT * FROM item').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'kept');
    assert.deepEqual(Buffer.from(rows[0].value), Buffer.from([0, 128, 255]));
    assert.throws(() => db.exec('DELETE FROM item'), /readonly/i);
    db.close(); db = undefined;
    const missing = join(directory, 'missing.univer');
    assert.throws(() => new Database(missing, { fileMustExist: true }), /ENOENT/);
    assert.equal(existsSync(missing), false);
    assert.throws(() => new Database(missing, { readonly: true }), /unable to open/i);
    assert.equal(existsSync(missing), false);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
