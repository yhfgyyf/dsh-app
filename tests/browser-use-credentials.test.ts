import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { BrowserUseCredentialsFile, parseExtensionToken } from '../src/main/browser-use-credentials.ts';

function cipher() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([enc.update(value, 'utf8'), enc.final()]);
      return Buffer.concat([iv, enc.getAuthTag(), encrypted]);
    },
    decryptString(value: Buffer) {
      const dec = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      dec.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([dec.update(value.subarray(28)), dec.final()]).toString('utf8');
    },
  };
}

test('accepts the extension copy button format and rejects invalid credentials without echoing them', () => {
  assert.equal(parseExtensionToken(' PLAYWRIGHT_MCP_EXTENSION_TOKEN=fixture-valid-token\n'), 'fixture-valid-token');
  assert.equal(parseExtensionToken(null), undefined);
  for (const value of [undefined, {}, '', 'invalid\nfixture-secret-token', 'x'.repeat(1025)]) assert.throws(() => parseExtensionToken(value), error => !String(error).includes('fixture-secret-token'));
});

test('credentials round trip as a private encrypted file and clearing works without encryption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-browser-credentials-'));
  const crypto = cipher(), store = new BrowserUseCredentialsFile(directory, crypto);
  assert.equal(await store.load(), undefined);
  const token = 'fixture-encrypted-token-1';
  await store.save(token);
  const saved = await readFile(store.path, 'utf8');
  assert.ok(!saved.includes(token));
  assert.equal(await new BrowserUseCredentialsFile(directory, crypto).load(), token);
  if (process.platform !== 'win32') assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  crypto.isEncryptionAvailable = () => false;
  await assert.rejects(store.save('fixture-encrypted-token-2'), /系统加密存储不可用/);
  assert.equal(await readFile(store.path, 'utf8'), saved);
  await store.save(undefined);
  assert.equal(await store.load(), undefined);
});

test('corrupt credentials and symlinks fail closed without exposing or overwriting their contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-browser-invalid-'));
  const store = new BrowserUseCredentialsFile(directory, cipher());
  await writeFile(store.path, '{"version":1,"encryptedToken":"invalid"}');
  await assert.rejects(store.load(), /无法解密/);
  const other = await mkdtemp(join(tmpdir(), 'dsh-browser-symlink-'));
  const linked = new BrowserUseCredentialsFile(other, cipher());
  await symlink(store.path, linked.path);
  await assert.rejects(linked.save('fixture-valid-token'), /无法安全读取/);
  await assert.rejects(linked.load(), /无法安全读取/);
  assert.equal(await readFile(store.path, 'utf8'), '{"version":1,"encryptedToken":"invalid"}');
});
