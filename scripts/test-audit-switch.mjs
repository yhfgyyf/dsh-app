import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { connectFixture } from '../tests/fixture-client.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.test-data'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/audit-switch-'));
const home = join(data, 'home'); await mkdir(home);
await mkdir(join(data, 'core'));
const inspectPlugin = join(data, 'inspect-fixture.mjs');
await writeFile(inspectPlugin, `export const inject = ['connection', 'webServer', 'cordisInspect', 'agents'];
export function apply(ctx) {
  ctx.connection.rpc.handle('/audit-test', async (_method, payload, signal) => {
    const providers = ctx.cordisInspect.list().filter(x => x.platform === 'host').map(x => x.id);
    const agent = ctx.agents.get(payload.args.agentId);
    if (providers.length) {
      await ctx.cordisInspect.query('host', 'Service', 'listService', undefined, agent, signal);
      await ctx.cordisInspect.query('host', 'Tool', 'listTools', undefined, agent, signal);
    }
    return { ok: true, value: providers };
  });
}`);
await writeFile(join(data, 'core/desktop.patch.yml'), '- insert:\n    - id: audit-test-inspect\n      name: ' + JSON.stringify(inspectPlugin) + '\n');
await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n');
const core = new DesktopRuntime({ runtimeRoot: join(root, '.runtime'), entry: join(root, '.runtime/app/index.ts'), home: join(data, 'core'), configHome: home, cwd: data, onExit: () => {} });
const results = [];
let client;
try {
  const ready = await core.start();
  const path = join(data, 'connection.json');
  await writeFile(path, JSON.stringify({ owner: 'dsh-desktop-test', ...ready }), { mode: 0o600 });
  client = await connectFixture(path);
  const create = async preset => (await client.rpc('session/create', { request: { cwd: data, agentPreset: preset } })).sessionId;
  const select = (agentId, agentPreset, allowFailure = false) => client.rpc('agentPresets/select', { agentId, agentPreset }, allowFailure);
  const inspect = agentId => client.rpc('inspect', { agentId }, false, '/audit-test');
  const first = await create('cordis');
  const second = await create('standard');
  const result = await select(second, 'audit', true);
  if (process.argv.includes('--expect-broken')) {
    assert.equal(result.ok, false);
    assert.match(result.error.message, /prefix.*missing required value/);
    assert.match(result.error.message, /inspect provider "Service" is already registered/);
    console.log('REPRODUCED both screenshot errors with two real sessions and no model request');
    results.push({ name: 'reproduced persona prefix and duplicate Host inspect errors', status: 'pass' });
  } else {
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value, 'audit');
    results.push({ name: 'switch standard to audit while Cordis session remains open', status: 'pass' });
    const third = await create('audit');
    assert.deepEqual((await inspect(third)).sort(), ['Builtin', 'Event', 'Service', 'Tool']);
    results.push({ name: 'two audit sessions and a Cordis session coexist', status: 'pass' });
    for (const [id, preset] of [[first, 'standard'], [second, 'standard'], [third, 'cordis'], [second, 'audit'], [third, 'audit'], [second, 'minimal'], [second, 'audit']]) {
      assert.equal(await select(id, preset), preset);
      assert.deepEqual((await inspect(third)).sort(), ['Builtin', 'Event', 'Service', 'Tool']);
    }
    results.push({ name: 'switch away and back repeatedly without losing shared inspection', status: 'pass' });
    await select(second, 'standard'); await select(third, 'standard');
    // DSH retains standing preset mounts for cold history reads until Host disposal.
    assert.deepEqual((await inspect(first)).sort(), ['Builtin', 'Event', 'Service', 'Tool']);
    await select(first, 'audit');
    assert.deepEqual((await inspect(first)).sort(), ['Builtin', 'Event', 'Service', 'Tool']);
    results.push({ name: 'cached standing presets preserve inspection across switch away and remount', status: 'pass' });
    console.log('PASS', results.map(x => x.name).join('; '));
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  client?.close(); await core.stop();
  await writeFile(join(root, 'docs/evidence/audit-switch' + (process.argv.includes('--expect-broken') ? '-before' : '') + '.json'), JSON.stringify({ at: new Date().toISOString(), data, scope: 'isolated actual DesktopRuntime; preset switching only, no model calls', results }, null, 2));
}
