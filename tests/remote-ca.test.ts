import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopRemoteAccess } from '../src/main/remote-access.ts';
import { RemoteCredentialsFile } from '../src/main/remote-access-credentials.ts';
import { RemoteBridge } from '../src/runtime/remote/bridge.ts';
import { defaultRemoteConfig, type RemoteRuntimeConfig } from '../src/shared/remote-access.ts';

const WebSocket = createRequire(new URL('../.runtime/package.json', import.meta.url))('ws');
const fixtureRoot = new URL('../services/relay/test/fixtures/ca/', import.meta.url);
const ca = await readFile(new URL('ca.pem', fixtureRoot), 'utf8');
const cert = await readFile(new URL('server.pem', fixtureRoot), 'utf8');
const key = await readFile(new URL('server-key.pem', fixtureRoot), 'utf8');
const expiredCa = await readFile(new URL('expired-ca.pem', fixtureRoot), 'utf8');
const expiredKey = await readFile(new URL('expired-ca-key.pem', fixtureRoot), 'utf8');
const fingerprint = new X509Certificate(ca).fingerprint256.replaceAll(':', '').toLowerCase();
const code = 'c'.repeat(43), secureCode = `dshca1_${fingerprint}_${code}`;
// This cipher tests the persistence boundary; authenticated encryption is covered separately.
const cipher = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };

async function fixture(options: { includeCa?: boolean; hostname?: string; expired?: boolean } = {}) {
  const requests: { path: string; body: any; authorization?: string }[] = [];
  let invitationsAvailable = true;
  const server = createServer({ key: options.expired ? expiredKey : key, cert: options.expired ? expiredCa : cert + (options.includeCa === false ? '' : ca) }, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ path: req.url!, body, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/register') {
      assert.equal(body.code, code, 'Only the original code is sent after TLS verification');
      res.end(JSON.stringify({ deviceId: 'desktop_fixture', deviceToken: 'device_token_fixture' }));
    } else if (req.url === '/v1/invite') {
      res.statusCode = invitationsAvailable ? 200 : 503;
      res.end(JSON.stringify({ inviteId: 'invite_fixture', claimSecret: 'claim_fixture', expiresAt: Date.now() + 120000 }));
    } else if (req.url === '/v1/bind') res.end(JSON.stringify({ bindingId: 'binding_fixture', bindingToken: 'binding_token_fixture' }));
    else res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `https://${options.hostname ?? '127.0.0.1'}:${(server.address() as any).port}`;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-ca-'));
  const file = new RemoteCredentialsFile(directory, cipher);
  await file.save({ ...defaultRemoteConfig(), relay: origin });
  let hostConfig: RemoteRuntimeConfig = { enabled: false };
  const remote = new DesktopRemoteAccess(file, async config => { hostConfig = config; }, () => {});
  await remote.restore();
  return { server, origin, requests, file, remote, config: () => hostConfig,
    setInvitationsAvailable: (value: boolean) => { invitationsAvailable = value; },
    close: async () => { remote.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); },
  };
}

test('a fingerprint-bearing code retrieves the private CA and restores verified HTTPS and WSS after restart', { timeout: 15000 }, async () => {
  const f = await fixture();
  const envBefore = { extra: process.env.NODE_EXTRA_CA_CERTS, reject: process.env.NODE_TLS_REJECT_UNAUTHORIZED };
  const local = createHttpServer((_req, res) => { res.setHeader('set-cookie', 'fixture=local; HttpOnly'); res.end(); });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const endpoint = `http://127.0.0.1:${(local.address() as any).port}`;
  const wss = new WebSocket.WebSocketServer({ server: f.server });
  const authenticated: any[] = [];
  wss.on('connection', (socket: any) => socket.on('message', (bytes: Buffer) => {
    authenticated.push(JSON.parse(bytes.toString())); socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  let bridge: RemoteBridge | undefined, restored: DesktopRemoteAccess | undefined;
  try {
    await f.remote.act({ type: 'register', code: secureCode });
    assert.equal(f.remote.state.registered, true);
    const saved = (await f.file.load()).credentials as any;
    assert.equal(new X509Certificate(saved.relayCa).fingerprint256.replaceAll(':', '').toLowerCase(), fingerprint);
    assert.equal(f.requests.length, 1, 'CA discovery must not send an HTTP request or credentials');
    f.remote.stop();
    let online: () => void;
    const connected = new Promise<void>(resolve => { online = resolve; });
    bridge = new RemoteBridge(WebSocket, endpoint, endpoint, state => { if (state.status === 'online') online(); });
    restored = new DesktopRemoteAccess(f.file, config => bridge!.configure(config), () => {});
    await restored.restore(); await restored.ready();
    await connected;
    assert.equal(restored.state.registered, true);
    assert.equal(authenticated[0].deviceToken, saved.deviceToken);
    await restored.act({ type: 'pair' });
    assert.ok(f.requests.some(r => r.path === '/v1/invite' && r.authorization === `Bearer ${saved.deviceToken}`));
    assert.deepEqual({ extra: process.env.NODE_EXTRA_CA_CERTS, reject: process.env.NODE_TLS_REJECT_UNAUTHORIZED }, envBefore);
  } finally {
    restored?.stop(); bridge?.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(r => wss.close(() => r()));
    await new Promise<void>(r => local.close(() => r())); await f.close();
  }
});

test('wrong CA fingerprints and incomplete chains reject before transmitting a registration code', async () => {
  for (const includeCa of [true, false]) {
    const f = await fixture({ includeCa });
    try {
      const input = includeCa ? `dshca1_${'0'.repeat(64)}_${code}` : secureCode;
      await assert.rejects(() => f.remote.act({ type: 'register', code: input }), /CA|指纹|证书/);
      assert.equal(f.requests.length, 0);
      assert.equal(f.remote.state.registered, false);
      assert.equal((await f.file.load()).credentials, undefined);
    } finally { await f.close(); }
  }
});

test('a matching CA never bypasses the relay hostname check', async () => {
  const f = await fixture({ hostname: 'localhost' });
  try {
    await assert.rejects(() => f.remote.act({ type: 'register', code: secureCode }), /地址|hostname|altnames|证书/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.remote.state.registered, false);
  } finally { await f.close(); }
});

test('an expired pinned CA rejects before transmitting the registration code', async () => {
  const f = await fixture({ expired: true });
  try {
    const hash = new X509Certificate(expiredCa).fingerprint256.replaceAll(':', '').toLowerCase();
    await assert.rejects(() => f.remote.act({ type: 'register', code: `dshca1_${hash}_${code}` }), /过期|尚未生效/);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.file.load()).credentials, undefined);
  } finally { await f.close(); }
});

test('legacy codes require trusted TLS and explain how to obtain an automatic-CA code', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.remote.act({ type: 'register', code }), /CA|指纹|证书/);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('LAN pairing, route failures, phone unbinding and restart retain registration until explicit unregister', async () => {
  const f = await fixture();
  let restored: DesktopRemoteAccess | undefined;
  try {
    await f.remote.act({ type: 'register', code: secureCode });
    const initial = (await f.file.load()).credentials!;
    f.remote.update({ status: 'online', lan: { origins: ['http://192.168.2.160:39001'], connections: [] } });
    for (const relayAvailable of [true, false]) {
      f.setInvitationsAvailable(relayAvailable);
      await f.remote.act({ type: 'pair' });
      const invite = f.config().invitation!;
      const receipt = await f.remote.localAction({ type: 'pair', inviteId: invite.id, name: relayAvailable ? 'Dual-route phone' : 'LAN-only phone' }) as any;
      assert.equal(f.remote.state.registered, true);
      assert.equal((await f.file.load()).credentials!.deviceToken, initial.deviceToken);
      await f.remote.act({ type: 'revoke', id: receipt.bindingId });
      assert.equal(f.remote.state.registered, true);
    }
    f.remote.update({ status: 'reconnecting', error: 'Relay temporarily unavailable', lan: { origins: [], connections: [] } });
    await f.remote.act({ type: 'configure', config: { ...f.remote.state.config, enabled: false } });
    assert.equal(f.remote.state.registered, true);
    f.remote.stop();
    restored = new DesktopRemoteAccess(f.file, async () => {}, () => {});
    await restored.restore();
    assert.equal(restored.state.registered, true);
    assert.equal(f.requests.filter(r => r.path === '/v1/unregister').length, 0);
    await restored.act({ type: 'unregister' });
    assert.equal(restored.state.registered, false);
    assert.equal((await f.file.load()).credentials, undefined);
    assert.equal(f.requests.filter(r => r.path === '/v1/unregister').length, 1);
  } finally { restored?.stop(); await f.close(); }
});
