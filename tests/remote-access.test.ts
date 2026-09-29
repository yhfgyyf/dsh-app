import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { defaultRemoteConfig, relayOrigin } from '../src/shared/remote-access.ts';
import { RemoteCredentialsFile } from '../src/main/remote-access-credentials.ts';
import { DesktopRemoteAccess } from '../src/main/remote-access.ts';
import { acceptClientHello, clientProof, createClientCipher } from '../src/runtime/remote/e2ee.ts';
import { permittedMux, permittedPath } from '../src/runtime/remote/policy.ts';

test('relay credentials stay on an explicit origin; public HTTP and URL confusion rejected', () => {
  assert.equal(relayOrigin('https://relay.example.com'), 'https://relay.example.com');
  assert.equal(relayOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const url of ['http://relay.example.com', 'https://u:p@relay.example.com', 'https://relay.example.com/api', 'https://relay.example.com/#secret', 'https://relay.example.com/?key=a', 'https://relay.example.com\\@evil.test']) assert.throws(() => relayOrigin(url));
  assert.equal(defaultRemoteConfig().enabled, false);
});
test('sealed-tunnel verifies peer identity, direction, ciphertext and exact sequence', () => {
  const key = Buffer.alloc(32, 1).toString('base64url'), random = Buffer.alloc(32, 2).toString('base64url'), id = 'test-session';
  const accepted = acceptClientHello(key, { accessSessionId: id, clientRandomB64: random, clientProofB64: clientProof(key, id, random) }, Buffer.alloc(32, 3));
  const client = createClientCipher(key, id, random, accepted.hello);
  const sealed = client.seal({ message: '你好，remote' });
  assert.deepEqual(accepted.cipher.open(sealed), { message: '你好，remote' });
  assert.throws(() => accepted.cipher.open(sealed));
  assert.throws(() => client.open(client.seal({ wrong: 'direction' })));
  assert.deepEqual(client.open(accepted.cipher.seal({ ok: true })), { ok: true });
  assert.throws(() => createClientCipher(Buffer.alloc(32, 4).toString('base64url'), id, random, accepted.hello));
});
test('viewer/control allowlists block settings, terminal, unknown APIs and mux bypasses', () => {
  assert.equal(permittedPath('POST', '/api/session/list', 'viewer'), '/api/session/list');
  assert.equal(permittedPath('POST', '/api/session/prompt', 'control'), '/api/session/prompt');
  for (const path of ['/api/session/prompt', '/api/$events/result', '/api/session/uploadFileBinary', '/api/workspaceFiles/read', '/api/directoryPicker/list']) assert.throws(() => permittedPath('POST', path, 'viewer'));
  for (const path of ['/api/settings/update', '/api/credentials/get', '/api/terminal/write', '/api/../session/list', '/api/%2e%2e/session/list', '//evil/api/session/list', '/api/session\\list']) assert.throws(() => permittedPath('POST', path, 'control'));
  permittedMux(JSON.stringify({ type: 'open', streamId: 'a', endpoint: '$events', payload: { args: {} } }), 'viewer');
  for (const endpoint of ['session/prompt', 'terminal/output', 'session/control', 'settings/update']) assert.throws(() => permittedMux(JSON.stringify({ type: 'open', streamId: 'a', endpoint }), 'viewer'));
});
test('credential persistence encrypts secrets, refuses plaintext backend and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-'));
  const key = randomBytes(32);
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]); },
    decryptString: (b: Buffer) => { const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString(); },
  };
  try {
    const file = new RemoteCredentialsFile(dir, cipher), config = { ...defaultRemoteConfig(), relay: 'https://relay.example.com', enabled: true };
    const credentials = { relay: config.relay, deviceId: 'desktop_test', deviceToken: 'test_token_secret', bindings: [] };
    await file.save(config, credentials);
    assert.equal((await readFile(file.path, 'utf8')).includes('test_token_secret'), false);
    assert.deepEqual((await file.load()).credentials, credentials);
    const unavailable = new RemoteCredentialsFile(dir, { ...cipher, getSelectedStorageBackend: () => 'basic_text' });
    await assert.rejects(() => unavailable.save(config, credentials));
    await unavailable.save({ ...config, sessionOnly: true }, credentials);
    assert.equal((await unavailable.load()).config.enabled, false);
    assert.equal((await unavailable.load()).credentials, undefined);
    await rm(file.path); await symlink(join(dir, 'other'), file.path);
    await assert.rejects(() => file.save(config, credentials));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('connection presence updates public status while diagnostics omit pairing identities and secrets', async () => {
  const config = { ...defaultRemoteConfig(), relay: 'https://relay.example.com', enabled: true };
  const credentials = { relay: config.relay, deviceId: 'desktop_test', deviceToken: 'private_device_token', bindings: [
    { id: 'binding_test', name: 'Private phone', account: 'private@example.test', role: 'viewer' as const, key: randomBytes(32).toString('base64url'), revoked: false },
  ] };
  const file = { available: () => true, load: async () => ({ config, credentials }) } as unknown as RemoteCredentialsFile;
  const remote = new DesktopRemoteAccess(file, async () => {}, () => {});
  await remote.restore();
  remote.update({ status: 'online', connections: ['binding_test'] });
  assert.equal(remote.state.devices[0].online, true);
  assert.ok(remote.state.devices[0].lastSeen! > 0);
  assert.equal('key' in remote.state.devices[0], false);
  assert.equal(remote.diagnostics().connectedPhones, 1);
  const diagnostics = JSON.stringify(remote.diagnostics());
  for (const secret of [credentials.deviceToken, credentials.deviceId, credentials.bindings[0].key, 'Private phone', 'private@example.test']) assert.equal(diagnostics.includes(secret), false);
  remote.update({ status: 'reconnecting' });
  assert.equal(remote.state.devices[0].online, false);
  assert.equal(remote.diagnostics().connectedPhones, 0);
});
