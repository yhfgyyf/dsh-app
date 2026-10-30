import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServer } from '../src/app-server.ts';
import { collaborationFixture } from '../../relay/test/collab-fixture.ts';
import { readConnection, callConnection } from '../src/daemon.ts';
import { McpClient, waitFor } from './helpers.ts';

const exec = promisify(execFile);
test('standalone bundle and installed native Codex discover both the Skill and MCP tools', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-plugin-install-')), home = join(root, 'profile'), codexHome = join(root, 'codex-home');
  const marketplace = join(root, 'marketplace'); await cp(fileURLToPath(new URL('../dist', import.meta.url)), marketplace, { recursive: true });
  await mkdir(codexHome);
  const entry = join(marketplace, 'plugins/dsh-codex-collab/cli.mjs'), env = { ...process.env, CODEX_HOME: codexHome, CODEX_COLLAB_HOME: home };
  const cli = async (args: string[]) => JSON.parse((await exec(process.execPath, [entry, ...args], { cwd: root, env, timeout: 20000, maxBuffer: 2 * 1024 * 1024 })).stdout);
  const native = async (args: string[]) => JSON.parse((await exec(process.env.CODEX_COLLAB_CODEX ?? 'codex', args, { cwd: root, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout);
  const app = new AppServer({ command: process.env.CODEX_COLLAB_CODEX ?? 'codex', args: ['app-server'], env }), relay = await collaborationFixture();
  let mcp: McpClient | undefined;
  try {
    const status = await cli(['status']); assert.equal(status.harness, 'codex');
    const connection = await readConnection(home); assert.ok(connection);
    await callConnection(connection, 'remote/register', { relay: relay.origin, code: relay.code, name: 'Packaged integration' });
    mcp = new McpClient(home, entry); await mcp.start(); assert.equal((await mcp.tool('collab_state')).registered, true);
    await native(['plugin', 'marketplace', 'add', marketplace, '--json']);
    const installed = await native(['plugin', 'add', 'dsh-codex-collab@dsh-local', '--json']);
    await app.start();
    const listed = await app.request('skills/list', { cwds: [root], forceReload: true });
    assert.ok(JSON.stringify(listed).includes('skills/collaboration/SKILL.md'), JSON.stringify(listed));
    const inventory = await app.request('mcpServerStatus/list', { limit: 100 });
    const server = inventory.data.find((s: any) => s.name.includes('dsh-collab') || Object.keys(s.tools ?? {}).includes('collab_start'));
    assert.ok(server, JSON.stringify(inventory));
    assert.ok(Object.keys(server.tools).includes('collab_start'), JSON.stringify(server));
    assert.ok(Object.keys(server.tools).length >= 50);
    await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/package-smoke.json', JSON.stringify({ passed: true, installed, server: server.name, toolCount: Object.keys(server.tools).length, skill: 'collaboration' }, null, 2), { mode: 0o600 });
  } finally {
    await app.stop(); await mcp?.close();
    const connection = await readConnection(home).catch(() => null);
    if (connection) {
      await callConnection(connection, 'service/stop').catch(() => {});
      await waitFor(() => { try { process.kill(connection.pid, 0); return false; } catch { return true; } }, 10000);
    }
    await relay.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('local installer preserves Codex preferences, records rollback, and can be removed with native commands', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-installer-')), codexHome = join(root, 'codex'), profile = join(root, 'profile');
  const original = 'model = "user-choice"\napproval_policy = "on-request"\n';
  await mkdir(codexHome); await writeFile(join(codexHome, 'config.toml'), original, { mode: 0o600 });
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_COLLAB_HOME: profile };
  let mcp: McpClient | undefined;
  const app = new AppServer({ command: process.env.CODEX_COLLAB_CODEX ?? 'codex', args: ['app-server'], env });
  const worker = new AppServer({ command: process.env.CODEX_COLLAB_CODEX ?? 'codex', env });
  try {
    const installed = JSON.parse((await exec(process.execPath, [fileURLToPath(new URL('../install.ts', import.meta.url)), '--codex-home', codexHome, '--home', profile, '--model', 'fixture-model'], { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })).stdout);
    const record = JSON.parse(await readFile(installed.record, 'utf8'));
    assert.equal(record.status, 'complete'); assert.equal(await readFile(record.before['config.toml'].backup, 'utf8'), original);
    assert.ok((await readFile(join(codexHome, 'config.toml'), 'utf8')).includes('model = "user-choice"'));
    await app.start();
    const inventory = await app.request('mcpServerStatus/list', { limit: 100 });
    assert.equal(Object.keys(inventory.data.find((s: any) => s.name === 'dsh-collab')?.tools ?? {}).length, 51, 'Installer-patched manifests must load in native Codex.');
    await app.stop();
    await worker.start();
    const workerInventory = await worker.request('mcpServerStatus/list', { limit: 100 });
    assert.equal(Object.keys(workerInventory.data.find((s: any) => s.name === 'dsh-collab')?.tools ?? {}).length, 0, 'Managed workers must not recursively expose their controlling service.');
    await worker.stop();
    const entry = join(installed.installed.installedPath, 'cli.mjs');
    mcp = new McpClient(profile, entry); await mcp.start(); assert.equal((await mcp.tool('status')).defaultModel, 'fixture-model');
    await mcp.close();
    const connection = await readConnection(profile); assert.ok(connection); await callConnection(connection, 'service/stop');
    await waitFor(() => { try { process.kill(connection.pid, 0); return false; } catch { return true; } }, 10000);
    await exec(process.env.CODEX_COLLAB_CODEX ?? 'codex', ['plugin', 'remove', 'dsh-codex-collab@dsh-local'], { env, timeout: 30000 });
    await exec(process.env.CODEX_COLLAB_CODEX ?? 'codex', ['plugin', 'marketplace', 'remove', 'dsh-local'], { env, timeout: 30000 });
    assert.ok((await readFile(join(codexHome, 'config.toml'), 'utf8')).includes('model = "user-choice"'));
    assert.equal(JSON.parse(await readFile(join(profile, 'codex-config.json'), 'utf8')).model, 'fixture-model');
  } finally {
    await app.stop(); await worker.stop(); await mcp?.close(); const connection = await readConnection(profile).catch(() => null);
    if (connection) { await callConnection(connection, 'service/stop').catch(() => {}); await waitFor(() => { try { process.kill(connection.pid, 0); return false; } catch { return true; } }, 10000); }
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
