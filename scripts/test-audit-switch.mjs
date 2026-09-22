import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { connectFixture } from '../tests/fixture-client.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeRoot = resolve(process.env.DSH_TEST_DESKTOP_RUNTIME ?? join(root, '.runtime'));
const presetIds = ['standard', 'ptc', 'minimal', 'cordis', 'audit', 'auto'];
await mkdir(join(root, '.test-data'), { recursive: true });
await mkdir(join(root, 'docs/evidence'), { recursive: true });
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
// Mount Audit normally but never start its external reviewer in this fixture.
await writeFile(join(data, 'core/desktop.patch.yml'), '- id: audit-bundle\n  config:\n    enabled: false\n- insert:\n    - id: audit-test-inspect\n      name: ' + JSON.stringify(inspectPlugin) + '\n');
await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n');
const core = new DesktopRuntime({ runtimeRoot, entry: join(runtimeRoot, 'app/index.ts'), home: join(data, 'core'), configHome: home, cwd: data, onExit: () => {} });
const results = [];
let client;
let status = 'pass';
let failure;
async function start() {
  const ready = await core.start();
  const path = join(data, 'connection.json');
  await writeFile(path, JSON.stringify({ owner: 'dsh-desktop-test', ...ready }), { mode: 0o600 });
  client = await connectFixture(path);
}
async function healthyRoster(phase) {
  const roster = await client.rpc('agentPresets/list');
  assert.equal(roster.modeSelectionEnabled, true, `${phase}: mode selection must be enabled`);
  for (const id of presetIds) {
    const preset = roster.presets.find(preset => preset.id === id);
    assert.ok(preset, `${phase}: missing ${id}`);
    assert.equal(preset.broken, undefined, `${phase}: ${id}: ${preset.broken}`);
  }
  results.push({ name: `${phase}: all six presets are available and healthy`, status: 'pass' });
}
async function readPreset(sessionId) {
  const history = client.follow('session/follow', { request: { address: { kind: 'session', sessionId } } });
  try {
    await history.wait(frames => frames.some(frame => frame.type === 'snapshot'));
    const snapshot = history.frames.find(frame => frame.type === 'snapshot');
    assert.equal(snapshot.header.id, sessionId);
    return snapshot.projections.values.agentPreset;
  } finally { history.close(); }
}
try {
  await start();
  if (!process.argv.includes('--expect-broken')) await healthyRoster('initial boot');
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
    assert.deepEqual((await inspect(third)).sort(), ['Config', 'Event', 'Service', 'Tool']);
    results.push({ name: 'two audit sessions and a Cordis session coexist', status: 'pass' });
    for (const [id, preset] of [[first, 'standard'], [second, 'standard'], [third, 'cordis'], [second, 'audit'], [third, 'audit'], [second, 'minimal'], [second, 'audit']]) {
      assert.equal(await select(id, preset), preset);
      assert.deepEqual((await inspect(third)).sort(), ['Config', 'Event', 'Service', 'Tool']);
    }
    results.push({ name: 'switch away and back repeatedly without losing shared inspection', status: 'pass' });
    await select(second, 'standard'); await select(third, 'standard');
    // DSH retains standing preset mounts for cold history reads until Host disposal.
    assert.deepEqual((await inspect(first)).sort(), ['Config', 'Event', 'Service', 'Tool']);
    await select(first, 'audit');
    assert.deepEqual((await inspect(first)).sort(), ['Config', 'Event', 'Service', 'Tool']);
    results.push({ name: 'cached standing presets preserve inspection across switch away and remount', status: 'pass' });
    for (const preset of [...presetIds, 'standard']) {
      assert.equal(await select(second, preset), preset);
      assert.equal(await readPreset(second), preset, `${preset}: selected mode must match session history`);
      assert.deepEqual((await inspect(first)).sort(), ['Config', 'Event', 'Service', 'Tool']);
    }
    results.push({ name: 'switch through standard, ptc, minimal, cordis, audit and auto with matching session projections', status: 'pass' });

    const restored = [{ id: first, preset: 'audit' }, { id: await create('auto'), preset: 'auto' }];
    for (const { id, preset } of restored) assert.equal(await readPreset(id), preset);
    client.close(); client = undefined;
    await core.stop();
    await start();
    await healthyRoster('cold restart');
    const listed = (await client.rpc('session/list', { _request: {} })).items;
    for (const { id, preset } of restored) {
      assert.ok(listed.some(session => session.sessionId === id), `${preset}: saved session must survive restart`);
      assert.equal(await readPreset(id), preset, `${preset}: restored projection must match`);
      assert.equal(await select(id, preset), preset, `${preset}: restored session must mount its preset`);
      assert.deepEqual((await inspect(id)).sort(), ['Config', 'Event', 'Service', 'Tool']);
    }
    results.push({ name: 'saved audit and auto sessions reopen and mount after a cold runtime restart', status: 'pass' });
    console.log('PASS', results.map(x => x.name).join('; '));
  }
} catch (error) {
  status = 'failed';
  failure = error instanceof Error ? error.message : String(error);
  console.error(error); process.exitCode = 1;
}
finally {
  client?.close(); await core.stop();
  await writeFile(join(root, 'docs/evidence/audit-switch' + (process.argv.includes('--expect-broken') ? '-before' : '') + '.json'), JSON.stringify({ at: new Date().toISOString(), status, failure, runtimeRoot, data, scope: 'isolated actual DesktopRuntime and profile root; preset list, switching, shared inspection and cold session restoration only; external Audit reviewer disabled; no prompt or model calls', results }, null, 2));
}
