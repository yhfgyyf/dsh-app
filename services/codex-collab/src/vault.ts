import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson, privateDirectory } from './storage.ts';
import { RemoteCredentialsFile } from '../../../src/main/remote-access-credentials.ts';

/** Native CLI-style private profile. Both the encrypted vault and its key are restricted to this OS user. */
export async function credentialFile(home: string) {
  await privateDirectory(home);
  if (process.platform === 'win32') throw new Error('This build needs a POSIX private profile. Windows credential ACL support has not been validated.');
  const path = join(home, 'vault-key.json');
  let data = await readJson<{ key: string } | null>(path, null);
  if (!data) { data = { key: randomBytes(32).toString('base64url') }; await writeJson(path, data); }
  const key = Buffer.from(data.key, 'base64url');
  if (key.length !== 32) throw new Error('Invalid vault key; the original was preserved.');
  return new RemoteCredentialsFile(home, {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8'); },
  });
}
