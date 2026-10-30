import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RelayProfileStore } from '../src/runtime/collab-profile-store.ts';

test('relay profiles encrypt device and phone secrets and restore isolated configurations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-relay-vault-'));
  try {
    const store = new RelayProfileStore(home); await store.restore();
    const a = await store.create('Relay A', 'https://a.example.test'), b = await store.create('Relay B', 'https://b.example.test');
    const file = await store.credentials(a.id), saved = await file.load(), secret = randomBytes(32).toString('base64url');
    const binding = { id: 'phone_fixture_A', name: 'A phone', account: '', role: 'control' as const, key: secret, revoked: false };
    await file.save(saved.config, { relay: a.relay, deviceId: 'device_fixture_A', deviceToken: secret, bindings: [binding] });
    const raw = await readFile(file.path, 'utf8');
    assert.ok(!raw.includes(secret)); assert.ok(!raw.includes('deviceToken')); assert.ok(!raw.includes(binding.id));
    assert.equal((await file.load()).credentials?.bindings[0].key, secret);
    assert.equal((await (await store.credentials(b.id)).load()).credentials, undefined);
    await store.save({ ...store.data, activeId: a.id });
    const restored = new RelayProfileStore(home); await restored.restore();
    assert.equal(restored.data.activeId, a.id); assert.equal((await (await restored.credentials(a.id)).load()).credentials?.deviceToken, secret);
    if (process.platform !== 'win32') { assert.equal((await stat(join(store.root, 'vault-key.json'))).mode & 0o777, 0o600); assert.equal((await stat(store.root)).mode & 0o777, 0o700); }
    await assert.rejects(file.save({ ...saved.config, relay: b.relay }, (await file.load()).credentials), /中继/);
    assert.throws(() => store.directory('../../credentials'), /编号/);
    await assert.rejects(store.create('Bad', 'https://relay.test/path'), /路径/);
    const damaged = JSON.parse(raw); const bytes = Buffer.from(damaged.encrypted, 'base64'); bytes[20] ^= 1; damaged.encrypted = bytes.toString('base64');
    await writeFile(file.path, JSON.stringify(damaged)); await assert.rejects(file.load());
    assert.equal(await readFile(file.path, 'utf8'), JSON.stringify(damaged), 'Corruption is never silently reset');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid and substituted profile indexes are preserved without loading credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-relay-index-'));
  try {
    const store = new RelayProfileStore(home); await store.restore();
    const file = join(store.root, 'profiles.json'); await writeFile(file, '{invalid');
    await assert.rejects(new RelayProfileStore(home).restore()); assert.equal(await readFile(file, 'utf8'), '{invalid');
    if (process.platform !== 'win32') {
      await rm(file); const external = join(home, 'external.json'); await writeFile(external, '{}'); await symlink(external, file);
      await assert.rejects(new RelayProfileStore(home).restore(), /无效/); assert.equal(await readFile(external, 'utf8'), '{}');
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
