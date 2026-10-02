import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { defaultRemoteConfig, relayOrigin } from '../src/shared/remote-access.ts';
import { RemoteCredentialsFile } from '../src/main/remote-access-credentials.ts';
import { DesktopRemoteAccess } from '../src/main/remote-access.ts';
import { acceptClientHello, clientProof, createClientCipher } from '../src/runtime/remote/e2ee.ts';
import { permittedMux, permittedPath } from '../src/runtime/remote/policy.ts';
import { HostTunnel } from '../src/runtime/remote/host-tunnel.ts';

test('relay credentials stay on an explicit origin; public HTTP and URL confusion rejected', () => {
  assert.equal(relayOrigin('https://relay.example.com'), 'https://relay.example.com');
  assert.equal(relayOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const url of ['http://relay.example.com', 'https://u:p@relay.example.com', 'https://relay.example.com/api', 'https://relay.example.com/#secret', 'https://relay.example.com/?key=a', 'https://relay.example.com\\@evil.test']) assert.throws(() => relayOrigin(url));
  assert.equal(defaultRemoteConfig().enabled, false);
  assert.equal(defaultRemoteConfig().background, true);
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
test('remote preview, speech and terminals require control while settings stay private', () => {
  for (const endpoint of ['pluginInventory/list', 'schedule/catalog', 'schedule/history']) assert.equal(permittedPath('POST', '/api/' + endpoint, 'viewer'), '/api/' + endpoint);
  for (const endpoint of ['schedule/create', 'schedule/update', 'schedule/delete']) {
    assert.equal(permittedPath('POST', '/api/' + endpoint, 'control'), '/api/' + endpoint);
    assert.throws(() => permittedPath('POST', '/api/' + endpoint, 'viewer'));
  }
  for (const endpoint of ['state', 'create', 'reply', 'start', 'run', 'generated-file', 'publish-run']) {
    assert.equal(permittedPath('POST', '/desktop-collab/' + endpoint, 'control'), '/desktop-collab/' + endpoint);
    assert.throws(() => permittedPath('POST', '/desktop-collab/' + endpoint, 'viewer'));
  }
  for (const path of ['/desktop-collab/profile', '/desktop-collab/unknown', '/desktop-collab/../api/settings/update', '/desktop-collab/state?other=1']) assert.throws(() => permittedPath('POST', path, 'control'));
  assert.equal(permittedPath('POST', '/api/session/list', 'viewer'), '/api/session/list');
  assert.equal(permittedPath('POST', '/api/session/prompt', 'control'), '/api/session/prompt');
  for (const path of ['/api/session/prompt', '/api/$events/result', '/api/session/uploadFileBinary', '/api/workspaceFiles/read', '/api/directoryPicker/list']) assert.throws(() => permittedPath('POST', path, 'viewer'));
  for (const endpoint of ['workspaceFiles/readBytes', 'officeToPdf/render', 'speech/catalog', 'speech/prepare', 'speech/transcribe',
    'terminal/environment', 'terminal/shells', 'terminal/list', 'terminal/create', 'terminal/write', 'terminal/resize', 'terminal/rename', 'terminal/close']) {
    assert.equal(permittedPath('POST', `/api/${endpoint}`, 'control'), `/api/${endpoint}`);
    assert.throws(() => permittedPath('POST', `/api/${endpoint}`, 'viewer'));
  }
  for (const endpoint of ['workspaceFiles/changes', 'terminal/follow', 'terminal/retain']) {
    permittedMux(JSON.stringify({ type: 'open', streamId: 'panel', endpoint }), 'control');
    assert.throws(() => permittedMux(JSON.stringify({ type: 'open', streamId: 'panel', endpoint }), 'viewer'));
  }
  for (const path of ['/api/settings/update', '/api/credentials/get', '/api/speech/configure', '/api/terminal/unknown', '/api/../session/list', '/api/%2e%2e/session/list', '//evil/api/session/list', '/api/session\\list']) assert.throws(() => permittedPath('POST', path, 'control'));
  permittedMux(JSON.stringify({ type: 'open', streamId: 'a', endpoint: '$events', payload: { args: {} } }), 'viewer');
  for (const endpoint of ['job/list', 'job/follow']) for (const role of ['viewer', 'control'] as const) {
    permittedMux(JSON.stringify({ type: 'open', streamId: 'jobs', endpoint, payload: { args: {} } }), role);
  }
  for (const endpoint of ['session/prompt', 'terminal/output', 'session/control', 'settings/update']) assert.throws(() => permittedMux(JSON.stringify({ type: 'open', streamId: 'a', endpoint }), 'viewer'));
});
test('denied streams remain separate from a fragmented Host frame under backpressure', { timeout: 2000 }, async () => {
  let socket: FakeSocket;
  class FakeSocket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    constructor() { super(); socket = this; }
    pause() {}
    resume() {}
    send() {}
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const key = randomBytes(32).toString('base64url'), random = randomBytes(32).toString('base64url'), id = 'fragment-test';
  const frames: any[] = [];
  let complete: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  let buffered = 0;
  const tunnel = new HostTunnel(FakeSocket, 'http://127.0.0.1', '', (_id, raw: any) => {
    if (raw.type !== 'sealed') return;
    const frame = client.open(raw) as any;
    if (frame.type !== 'ws_data') return;
    frames.push(frame);
    if (frames.length === 1) {
      buffered = 150000;
      queueMicrotask(() => tunnel.receive(id, client.seal({ type: 'ws_data', channel: 'mux', text: JSON.stringify({ type: 'open', streamId: 'denied', endpoint: 'settings/private' }) })));
      setTimeout(() => { buffered = 0; }, 15);
    }
    if (frames.length === 4) complete();
  }, () => true, () => buffered, () => {});
  const hello = tunnel.accept(id, { id: 'binding', name: 'phone', account: 'local', role: 'control', key, revoked: false },
    { accessSessionId: id, clientRandomB64: random, clientProofB64: clientProof(key, id, random) });
  const client = createClientCipher(key, id, random, hello);
  try {
    tunnel.receive(id, client.seal({ type: 'ws_open', channel: 'mux' }));
    const large = { type: 'item', streamId: 'session', value: 'x'.repeat(100000) };
    socket!.emit('message', Buffer.from(JSON.stringify(large)));
    await completed;
    const messages: any[] = [], chunks: Buffer[] = [];
    for (const frame of frames) {
      chunks.push(Buffer.from(frame.data, 'base64'));
      if (frame.final) { messages.push(JSON.parse(Buffer.concat(chunks).toString())); chunks.length = 0; }
    }
    assert.deepEqual(messages[0], large);
    assert.equal(messages[1].streamId, 'denied');
    assert.equal(messages[1].error.code, 'forbidden');
    assert.equal(socket!.readyState, 1);
  } finally { tunnel.stop(); }
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
    const local = { deviceId: 'computer_test', port: 49876, bindings: [
      { id: 'phone_binding', name: 'phone', account: 'local', role: 'control' as const, key: randomBytes(32).toString('base64url'), revoked: false },
    ] };
    await file.save({ ...config, relay: '' }, undefined, local);
    assert.deepEqual((await file.load()).local, local);
    assert.equal((await file.load()).config.enabled, true);
    for (const secret of [local.deviceId, local.bindings[0].id, local.bindings[0].key]) assert.equal((await readFile(file.path, 'utf8')).includes(secret), false);
    await writeFile(file.path, JSON.stringify({ version: 1, config: { ...config, background: false }, encrypted: cipher.encryptString(JSON.stringify(credentials)).toString('base64') }));
    assert.deepEqual((await file.load()).credentials, credentials);
    assert.equal((await file.load()).config.background, true);
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
