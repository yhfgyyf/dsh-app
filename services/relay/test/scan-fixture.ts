import { DesktopRuntime } from '../../../src/main/runtime.ts';
import { DesktopRemoteAccess } from '../../../src/main/remote-access.ts';
import type { RemoteRuntimeConfig } from '../../../src/shared/remote-access.ts';
import type { RemoteCredentialsFile } from '../../../src/main/remote-access-credentials.ts';
import { defaultRemoteConfig } from '../../../src/shared/remote-access.ts';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { PrivateStore } from '../src/private-store.js';
import { createPrivateRelay } from '../src/private-server.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
await mkdir(join(root, '.test-data'), { recursive: true });
const cwd = await mkdtemp(join(root, '.test-data/scan-host-')), home = join(cwd, 'home'); await mkdir(home);
if (process.env.DSH_TEST_SPEECH_MODELS) {
  // Reuse verified local weights read-only. The worker and all mutable state belong to this fixture.
  const speech = join(home, 'speech-to-text/sensevoice'); await mkdir(speech, { recursive: true });
  await symlink(process.env.DSH_TEST_SPEECH_MODELS, join(speech, 'models'), 'dir');
  const profile = join(cwd, 'core/profiles/desktop'); await mkdir(profile, { recursive: true });
  // Also cover upgrades of an existing profile that already enabled the official voice bundle.
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'fixture-voice', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-desktop-surface', '@deepseek-ai/dsh-experimental-voice-input-bundle'] } } }));
}
await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n');
const store = new PrivateStore(':memory:');
const relay = createPrivateRelay(store, 'http://127.0.0.1:8787');
relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
const origin = `http://127.0.0.1:${(relay.server.address() as any).port}`;
let invitation: ReturnType<PrivateStore['invite']> | undefined;
const invite = store.invite.bind(store); store.invite = (device, qr) => (invitation = invite(device, qr));
let config: RemoteRuntimeConfig = { enabled: false };
let desktop: DesktopRemoteAccess;
const core = new DesktopRuntime({ runtimeRoot: join(root, '.runtime'), entry: join(root, '.runtime/app/index.ts'), home: join(cwd, 'core'), configHome: home, cwd,
  onExit: () => {}, remoteState: value => desktop?.update(value), localRemoteAction: action => desktop.localAction(action) });
const file = { available: () => true, save: async () => {}, load: async () => ({ config: defaultRemoteConfig() }) } as unknown as RemoteCredentialsFile;
desktop = new DesktopRemoteAccess(file, async value => { config = value; await core.configureRemote(value); }, () => {});
await core.start(); await desktop.restore(); await desktop.ready();
if (process.argv.includes('--relay')) {
  store.provision('scan@example.test', 'test-password-long');
  await desktop.act({ type: 'configure', config: { ...defaultRemoteConfig(), relay: origin } });
  await desktop.act({ type: 'register', code: store.registration('scan@example.test') });
}
await desktop.act({ type: 'pair' });
const local = config.local!, pairing = config.invitation!;
if (!desktop.state.lan?.origins.length) throw new Error('This test needs a private IPv4 interface');
const qr = { kind: 'dsh-desktop-pair', version: 2, computerId: local.deviceId, name: 'Scan fixture', key: pairing.key, expiresAt: pairing.expiresAt,
  lan: { origins: desktop.state.lan.origins, inviteId: pairing.id },
  ...(invitation ? { relay: { origin, deviceId: config.credentials!.deviceId, inviteId: invitation.inviteId, claimSecret: invitation.claimSecret } } : {}) };
// Only short-lived fixture credentials go over this private child-process pipe.
console.log(JSON.stringify({ qr, cwd, origin }));
let closing = false;
async function close() { if (closing) return; closing = true; desktop.stop(); await core.stop(); await relay.close(); store.db.close(); }
process.stdin.resume(); process.stdin.on('end', () => void close()); process.on('SIGTERM', () => void close());
