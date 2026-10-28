import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { PrivateStore } from '../src/private-store.ts';
import { registrationCodeWithCa } from '../src/registration-code.ts';

const caPath = fileURLToPath(new URL('./fixtures/ca/ca.pem', import.meta.url));
const serverPath = fileURLToPath(new URL('./fixtures/ca/server.pem', import.meta.url));
const ca = readFileSync(caPath, 'utf8');
const expiredCa = readFileSync(new URL('./fixtures/ca/expired-ca.pem', import.meta.url), 'utf8');
const fingerprint = new X509Certificate(ca).fingerprint256.replaceAll(':', '').toLowerCase();

test('CA registration codes retain the existing one-use registration token and database schema', () => {
  const store = new PrivateStore(':memory:');
  try {
    store.provision('ca@example.test', 'fixture-password-only');
    const plain = store.registration('ca@example.test');
    const full = registrationCodeWithCa(plain, ca);
    assert.equal(full, `dshca1_${fingerprint}_${plain}`);
    assert.ok(full.length <= 128);
    assert.ok(store.register(full.slice(72), 'Fixture Desktop'));
    assert.equal(store.register(plain, 'Duplicate Desktop'), undefined);
    assert.throws(() => registrationCodeWithCa(plain, readFileSync(serverPath, 'utf8')), /root CA/);
    assert.throws(() => registrationCodeWithCa(plain, expiredCa), /expired/);
    assert.throws(() => registrationCodeWithCa('truncated', ca), /complete/);
  } finally { store.db.close(); }
});

test('admin and standalone tools issue matching codes without changing a running relay or disclosing private keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-admin-ca-'));
  const database = join(directory, 'fixture.db');
  const store = new PrivateStore(database);
  const email = 'admin-ca@example.test';
  const admin = fileURLToPath(new URL('../src/private-admin.ts', import.meta.url));
  const wrapper = fileURLToPath(new URL('../src/registration-code.ts', import.meta.url));
  const env = { ...process.env, DB_PATH: database };
  try {
    store.provision(email, 'fixture-password-only');
    const full = execFileSync(process.execPath, ['--import', 'tsx', admin, 'registration', email, '--ca-file', caPath], { env, encoding: 'utf8' }).trim();
    assert.match(full, new RegExp(`^dshca1_${fingerprint}_[A-Za-z0-9_-]{43}$`));
    assert.ok(store.register(full.slice(72), 'Admin fixture'));
    const plain = execFileSync(process.execPath, ['--import', 'tsx', admin, 'registration', email], { env, encoding: 'utf8' }).trim();
    assert.match(plain, /^[A-Za-z0-9_-]{43}$/);
    const wrapped = execFileSync(process.execPath, ['--import', 'tsx', wrapper, caPath], { input: plain + '\n', encoding: 'utf8' }).trim();
    assert.equal(wrapped, registrationCodeWithCa(plain, ca));
    assert.ok(store.register(wrapped.slice(72), 'Legacy relay fixture'));
    const before = store.db.prepare('SELECT count(*) AS n FROM remote_codes').get();
    assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', admin, 'registration', email, '--ca-file', serverPath], { env, stdio: 'pipe' }));
    assert.deepEqual(store.db.prepare('SELECT count(*) AS n FROM remote_codes').get(), before);
  } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
