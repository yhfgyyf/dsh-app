import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { CollabRelayManager } from '../src/runtime/collab-relays.ts';
import { CollabClient } from '../src/runtime/collab-client.ts';
import { createCollabBroker } from '../src/runtime/collab-transport.ts';
import { defaultRemoteConfig } from '../src/shared/remote-access.ts';
import { collaborationFixture } from '../services/relay/test/collab-fixture.ts';
import { RemoteTestClient } from './remote-client.ts';

const WS = createRequire(new URL('../services/relay/package.json', import.meta.url))('ws');
async function waitFor(fn: () => boolean | Promise<boolean>) { const deadline = Date.now() + 10000; while (!await fn()) { if (Date.now() > deadline) throw new Error('Test condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } }

test('two relay profiles preserve identities, recovery, drafts, progress and phones; switch never unregisters', { timeout: 45000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-two-relays-'));
  const [a, b] = await Promise.all([collaborationFixture(), collaborationFixture()]);
  const sockets: any[] = [];
  function WebSocket(url: string, options: object) { const socket = new WS(url, options); if (url.endsWith('/v1/device')) sockets.push(socket); return socket; }
  WebSocket.WebSocketServer = WS.WebSocketServer;
  const host = createServer((req, res) => { res.setHeader('set-cookie', 'host_fixture=local_only; HttpOnly'); res.setHeader('content-type', 'application/json'); res.end('{"items":[]}'); });
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  const endpoint = 'http://127.0.0.1:' + (host.address() as any).port, connection = { WebSocket, endpoint, launchUrl: endpoint };
  const sessions = new Map<string, { status: string; cancel(): void }>();
  let cancellations = 0;
  const ctx: any = { desktopCollabBroker: { isRegistered: () => false, grant: async () => { throw new Error('No legacy registration'); } },
    agents: { get: (id: string) => sessions.get(id) }, sessionPersistence: { flush: async () => {}, list: async () => [...sessions.keys()].map(id => ({ header: { id } })) },
    sessionController: { create: async ({ sessionId }: any) => { sessions.set(sessionId, { status: 'idle', cancel() { cancellations++; this.status = 'idle'; } }); },
      rename: async () => {}, prompt: async ({ sessionId }: any) => { sessions.get(sessionId)!.status = 'running'; },
      inspect: async (id: string) => ({ meta: { id }, inheritedEventCount: 0, events: [] }) } };
  const make = () => new CollabRelayManager(home, ctx, () => undefined, { appVersion: 'fixture', runtimeVersion: 'fixture', pluginVersion: 'fixture', platform: process.platform, arch: process.arch });
  let manager = make(); const phone = new RemoteTestClient();
  const call = async (method: string, args: object = {}) => { const result = await manager.handle(method, { args }, new AbortController().signal); if (!result.ok) throw new Error(result.error.message); return result.value; };
  try {
    await manager.start(connection);
    const originalIdentity = (await call('state')).peer.id, deviceA = a.devices[1], bound = a.relayStore.bind(deviceA.deviceId, 'Phone A')!;
    const keyA = randomBytes(32).toString('base64url'), bindingA = { id: bound.bindingId, name: 'Phone A', account: '', role: 'control' as const, key: keyA, revoked: false };
    manager.capture({ type: 'remote-configure', config: { enabled: false, credentials: { relay: a.origin, ...deviceA, bindings: [bindingA] }, local: { deviceId: 'local_device_A', bindings: [bindingA] } } });
    let state = await call('relays/adopt', { config: { ...defaultRemoteConfig(), relay: a.origin, enabled: true } });
    const idA = state.activeId; assert.equal((await call('state')).peer.id, originalIdentity);
    await call('sync'); const recoveryA = await readFile(join(home, 'collaboration/recovery.json'), 'utf8');
    await call('draft-put', { key: 'shared-key', value: { body: 'Only relay A' }, $relayProfileId: idA });
    await waitFor(async () => (await call('relays/state')).remote.status === 'online');
    await phone.connect(a.origin, bound.bindingId, bound.bindingToken, keyA);
    assert.equal((await phone.http('/api/session/list')).status, 200);
    const runId = randomUUID(); await call('start', { operationId: runId, taskId: a.task.id, mode: 'solve', instruction: 'Fixture only', maxTokens: 1000, maxMinutes: 1 });
    const runBefore = (await call('state')).runs.find((r: any) => r.id === runId); assert.equal(runBefore.status, 'running');
    state = await call('relays/create', { name: 'Relay B', relay: b.origin }); const idB = state.profiles.find((p: any) => p.name === 'Relay B').id;
    const aSocket = sockets.at(-1);
    const queued = await Promise.allSettled([call('relays/switch', { id: idB }), call('draft-put', { key: 'queued-phone-write', value: 'from A phone' }), call('state')]);
    assert.equal(queued[0].status, 'fulfilled'); assert.equal(queued[1].status, 'rejected'); assert.equal(queued[2].status, 'rejected');
    assert.equal(await call('draft-get', { key: 'queued-phone-write' }), null);
    await waitFor(() => aSocket.readyState === WS.CLOSED); await waitFor(() => phone.socket.readyState === WS.CLOSED);
    assert.ok(cancellations >= 1); assert.ok(a.relayStore.device(deviceA.deviceId, deviceA.deviceToken));
    const identityB = (await call('state')).peer.id; assert.notEqual(identityB, originalIdentity); assert.equal(await call('draft-get', { key: 'shared-key' }), null);
    await assert.rejects(call('draft-put', { key: 'shared-key', value: 'late A save', $relayProfileId: idA }), /原配置/);
    await call('relays/remote', { profileId: idB, action: { type: 'register', code: b.code } }); await call('sync');
    await call('draft-put', { key: 'shared-key', value: { body: 'Only relay B' }, $relayProfileId: idB });
    const fileB = await manager.store.credentials(idB), savedB = await fileB.load(), deviceB = savedB.credentials!;
    assert.ok(b.relayStore.device(deviceB.deviceId, deviceB.deviceToken));
    const recoveryB = await readFile(join(manager.store.directory(idB), 'collaboration/recovery.json'), 'utf8'); assert.notEqual(recoveryB, recoveryA);
    assert.equal(JSON.stringify(await call('relays/state')).includes(deviceB.deviceToken), false);
    await call('relays/switch', { id: idA });
    const boundB = b.relayStore.bind(deviceB.deviceId, 'Phone B')!, bindingB = { ...bindingA, id: boundB.bindingId, name: 'Phone B', key: randomBytes(32).toString('base64url') };
    const latestB = await fileB.load(); latestB.credentials!.bindings = [bindingB]; latestB.local!.bindings = [bindingB]; await fileB.save(latestB.config, latestB.credentials, latestB.local);
    assert.equal((await call('draft-get', { key: 'shared-key' })).body, 'Only relay A');
    let restored = await call('state'); assert.equal(restored.peer.id, originalIdentity); assert.equal(restored.runs.find((r: any) => r.id === runId).status, 'stopped'); assert.equal(restored.attempts[0].desiredState, 'paused');
    assert.deepEqual((await call('relays/state')).remote.devices.map((d: any) => d.name), ['Phone A']);
    await call('relays/switch', { id: idB });
    assert.deepEqual((await call('relays/state')).remote.devices.map((d: any) => d.name), ['Phone B']);
    await manager.stop(); manager = make(); await manager.start(connection);
    restored = await call('state'); assert.equal(restored.relayProfileId, idB); assert.equal(restored.peer.id, identityB); assert.equal((await call('draft-get', { key: 'shared-key' })).body, 'Only relay B');
    assert.equal(await readFile(join(home, 'collaboration/recovery.json'), 'utf8'), recoveryA);
    assert.equal(await readFile(join(manager.store.directory(idB), 'collaboration/recovery.json'), 'utf8'), recoveryB);
    await assert.rejects(call('relays/remote', { profileId: idB, action: { type: 'unregister' } }), /确认/);
    await call('relays/remote', { profileId: idB, action: { type: 'unregister' }, confirm: true });
    assert.equal(b.relayStore.device(deviceB.deviceId, deviceB.deviceToken), undefined); assert.ok(a.relayStore.device(deviceA.deviceId, deviceA.deviceToken));
    assert.equal((await call('draft-get', { key: 'shared-key' })).body, 'Only relay B');
    await call('relays/switch', { id: idA });
    const bytesB = await readFile(fileB.path, 'utf8'); await writeFile(fileB.path, '{invalid');
    await assert.rejects(call('relays/switch', { id: idB })); assert.equal((await call('state')).relayProfileId, idA); assert.equal((await call('draft-get', { key: 'shared-key' })).body, 'Only relay A');
    assert.equal(await readFile(fileB.path, 'utf8'), '{invalid'); await writeFile(fileB.path, bytesB);
    const save = manager.store.save.bind(manager.store); manager.store.save = async data => { if (data.activeId === idB) throw new Error('Fixture index write failure'); return save(data); };
    await assert.rejects(call('relays/switch', { id: idB }), /index write/); assert.equal((await call('state')).relayProfileId, idA); manager.store.save = save;
    await waitFor(async () => (await call('relays/state')).remote.status === 'online');
    assert.equal(sockets.filter(s => s.readyState === WS.OPEN).length, 1, 'Rollback leaves exactly one live device connection');
  } finally { phone.close(); await manager.stop(); host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve())); await Promise.all([a.close(), b.close()]); await rm(home, { recursive: true, force: true }); }
});

for (const partial of [false, true]) test(`legacy identity on another relay is retained separately during ${partial ? 'a failed 0.3.0 migration retry' : 'first migration'}`, { timeout: 45000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-legacy-relay-'));
  const [oldRelay, currentRelay] = await Promise.all([collaborationFixture(), collaborationFixture()]);
  const oldDevice = oldRelay.devices[1], currentDevice = currentRelay.devices[1];
  const legacy = new CollabClient(home, createCollabBroker(() => ({ relay: oldRelay.origin, ...oldDevice, bindings: [] })));
  const ctx: any = { desktopCollabBroker: { isRegistered: () => false, grant: async () => { throw new Error('Native registration is disabled'); } },
    agents: { get: () => undefined }, sessionPersistence: { flush: async () => {}, list: async () => [] } };
  const make = () => new CollabRelayManager(home, ctx, () => undefined, { appVersion: 'fixture', runtimeVersion: 'fixture', pluginVersion: 'fixture', platform: process.platform, arch: process.arch });
  const connection = { WebSocket: WS, endpoint: 'http://127.0.0.1:1', launchUrl: 'http://127.0.0.1:1' };
  let manager = make();
  const call = async (method: string, args: object = {}) => { const result = await manager.handle(method, { args }, new AbortController().signal); if (!result.ok) throw new Error(result.error.message); return result.value; };
  try {
    await legacy.restore(); legacy.start(); await legacy.sync();
    legacy.data.drafts['new-task'] = { body: 'Retained old relay draft' }; await legacy.save(); await legacy.stop();
    const identity = legacy.data.peerId, profileBytes = await readFile(join(home, 'collaboration/profile.json'), 'utf8');
    const recoveryBytes = await readFile(join(home, 'collaboration/recovery.json'), 'utf8');
    await manager.start(connection);
    const binding = { id: 'phone_current_relay', name: 'Current phone', account: '', role: 'control' as const, key: randomBytes(32).toString('base64url'), revoked: false };
    const credentials = { relay: currentRelay.origin, ...currentDevice, bindings: [binding] };
    const config = { ...defaultRemoteConfig(), relay: currentRelay.origin, name: 'Current relay' };
    manager.capture({ type: 'remote-configure', config: { enabled: false, credentials } });
    let partialId: string | undefined;
    if (partial) {
      const pending = await manager.store.create('Current relay', currentRelay.origin); partialId = pending.id;
      await (await manager.store.credentials(pending.id)).save(config, credentials);
      await manager.store.save({ ...manager.store.data, profiles: [{ ...pending, legacy: true }] });
    }
    let state = await call('relays/adopt', { config });
    assert.equal(state.profiles.length, 2);
    const previous = state.profiles.find((p: any) => p.relay === oldRelay.origin), current = state.profiles.find((p: any) => p.relay === currentRelay.origin);
    assert.equal(previous.legacy, true); assert.equal(previous.registered, false); assert.equal(current.legacy, undefined);
    assert.equal(state.activeId, current.id); if (partialId) assert.equal(current.id, partialId);
    assert.equal(state.remote.registered, true); assert.deepEqual(state.remote.devices.map((d: any) => d.name), ['Current phone']);
    assert.equal((await (await manager.store.credentials(current.id)).load()).credentials?.deviceToken, currentDevice.deviceToken);
    assert.equal((await (await manager.store.credentials(previous.id)).load()).credentials, undefined);
    assert.notEqual((await call('state')).peer.id, identity); assert.equal(await call('draft-get', { key: 'new-task' }), null);
    assert.equal(await readFile(join(home, 'collaboration/profile.json'), 'utf8'), profileBytes);
    assert.equal(await readFile(join(home, 'collaboration/recovery.json'), 'utf8'), recoveryBytes);
    await call('relays/switch', { id: previous.id });
    assert.equal((await call('state')).peer.id, identity); assert.equal((await call('draft-get', { key: 'new-task' })).body, 'Retained old relay draft');
    await call('relays/switch', { id: current.id });
    await manager.stop(); manager = make(); await manager.start(connection);
    state = await call('relays/adopt', { config }); assert.equal(state.profiles.length, 2); assert.equal(state.activeId, current.id);
    assert.ok(oldRelay.relayStore.device(oldDevice.deviceId, oldDevice.deviceToken)); assert.ok(currentRelay.relayStore.device(currentDevice.deviceId, currentDevice.deviceToken));
    assert.equal(await readFile(join(home, 'collaboration/recovery.json'), 'utf8'), recoveryBytes);
  } finally { await legacy.stop(); await manager.stop(); await Promise.all([oldRelay.close(), currentRelay.close()]); await rm(home, { recursive: true, force: true }); }
});
