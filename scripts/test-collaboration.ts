import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { connectFixture } from '../tests/fixture-client.ts';
import { collaborationFixture } from '../services/relay/test/collab-fixture.ts';

const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.test-data'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/collaboration-'));
const home = join(data, 'home'), state = join(data, 'state'); await mkdir(home); await mkdir(state);
const fixture = await collaborationFixture({ rejectCollaborationWebSocket: true });
let modelCalls = 0;
const model = createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'deepseek-flash', object: 'model' }] })); return; }
  if (!req.url?.endsWith('/messages')) { res.writeHead(404); res.end('{}'); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body); modelCalls++;
  const answer = 'COLLAB_SOLVED_OK：输入与缓存分开统计；已通过本地夹具验证。';
  const usage = { input_tokens: 128, cache_read_input_tokens: 64, cache_creation_input_tokens: 16, output_tokens: 32 };
  const message = { id: randomUUID(), type: 'message', role: 'assistant', model: input.model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage };
  if (!input.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
  emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 32 } });
  emit('message_stop', {}); res.end();
});
await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
const modelPort = (model.address() as any).port;
await writeFile(join(state, 'desktop.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${modelPort}\n    apiKeyEnv: DSH_COLLAB_FIXTURE_KEY\n    maxTokens: 4096\n`);
await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n');
process.env.DSH_COLLAB_FIXTURE_KEY = 'isolated-local-fixture';
const runtimeRoot = join(root, '.runtime');
const runtime = new DesktopRuntime({ runtimeRoot, entry: join(runtimeRoot, 'app/index.ts'), home: state, configHome: home, cwd: data, onExit: () => {} });
let client: Awaited<ReturnType<typeof connectFixture>> | undefined, logs = '';
const checks: string[] = [];
const wait = async <T>(fn: () => Promise<T | false>, label: string, timeout = 30000) => {
  const started = Date.now(); for (;;) { const result = await fn(); if (result) return result; if (Date.now() - started > timeout) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 150)); }
};
async function start() {
  const ready = await runtime.start();
  for (const stream of [runtime.child?.stdout, runtime.child?.stderr]) stream?.on('data', chunk => { logs += String(chunk); });
  await runtime.configureRemote({ enabled: false, credentials: { relay: fixture.origin, deviceId: fixture.devices[1].deviceId, deviceToken: fixture.devices[1].deviceToken, bindings: [] } });
  const path = join(data, 'connection.json'); await writeFile(path, JSON.stringify({ owner: 'dsh-desktop-test', ...ready }), { mode: 0o600 });
  client = await connectFixture(path); return ready;
}
let failure: string | undefined;
try {
  const initial = await start(); assert.ok(!initial.graph.entries.some(e => e.id === 'dsh-p2p-collab'));
  const bundles = await client!.rpc('pluginManager/listBundles');
  const bundle = bundles.find((b: any) => b.name === 'dsh-p2p-collab'); assert.ok(bundle, 'Bundled plugin must be discoverable'); assert.equal(bundle.enabled, false);
  const enabled = await client!.rpc('pluginManager/setBundleEnabled', { name: 'dsh-p2p-collab', enabled: true });
  await writeFile(join(data, 'enabled.json'), JSON.stringify(enabled, null, 2));
  const rpc = <T = any>(method: string, args: object = {}) => client!.rpc(method, args, false, '/desktop-collab') as Promise<T>;
  const stateValue = await rpc('sync');
  assert.ok((await runtime.graph()).entries.some(e => e.id === 'dsh-p2p-collab'));
  checks.push('Plugin is initially disabled, discoverable, and enabled live through the production plugin manager');
  const taskId = fixture.task.id;
  assert.equal((await rpc('detail', { taskId })).task.title, fixture.task.title);
  await rpc('catalog'); await rpc('follow', { taskId, following: true }); assert.equal(modelCalls, 0);
  const publish = { operationId: randomUUID(), title: '桌面新任务', description: '从真实 Host 发布' };
  const own = await rpc('create', publish); assert.equal((await rpc('create', publish)).id, own.id);
  const runId = randomUUID();
  const run = await rpc('start', { operationId: runId, taskId, mode: 'solve' });
  assert.ok(run.sessionId.startsWith('session-')); await rpc('start', { operationId: runId, taskId, mode: 'solve' });
  const completed = await wait(async () => { const r = await rpc('run', { runId }); return r.status !== 'running' && r.status !== 'preparing' && r; }, 'Local solve did not settle');
  await writeFile(join(data, 'run.json'), JSON.stringify(completed, null, 2));
  assert.equal(completed.status, 'completed'); assert.match(completed.output, /COLLAB_SOLVED_OK/); assert.equal(modelCalls, 1);
  assert.equal(completed.report.usage.status, 'complete');
  assert.deepEqual(completed.report.usage.totals, { uncachedInputTokens: 128, cacheReadTokens: 64, cacheWriteTokens: 16, outputTokens: 32, reasoningTokens: null, totalTokens: 240 });
  assert.equal((await fixture.call(0, 'tasks/' + taskId)).replies.length, 0, 'Solve must never upload automatically');
  const submission = { operationId: randomUUID(), taskId, kind: 'solution', body: completed.output, baseRevision: 1, runId, reportSnapshot: completed.reportSnapshot, solution: { verification: 'Deterministic local model fixture passed', limitations: 'No external model or device test' } };
  const reply = await rpc('reply', submission); assert.equal((await rpc('reply', submission)).id, reply.id);
  const detail = await fixture.call(0, 'tasks/' + taskId); assert.equal(detail.replies.length, 1); assert.equal(detail.replies[0].actor, 'dsh');
  assert.equal((await fixture.call(0, `tasks/${taskId}/accept`, { operationId: randomUUID(), revision: detail.task.revision, replyId: reply.id })).status, 'resolved');
  await rpc('sync'); assert.ok((await rpc('state')).unread > 0, 'Author acceptance did not reach subscribed desktop');
  checks.push('Browse/follow use no model; explicit solve invokes one mock call; usage is 128 + 64 + 16 + 32 = 240; previewed solution submits exactly once and author accepts');
  client!.close(); client = undefined; await runtime.stop(); await start();
  const restored = await rpc('sync');
  assert.equal(restored.peer.id, stateValue.peer.id); assert.equal((await rpc('detail', { taskId })).task.status, 'resolved');
  assert.equal(modelCalls, 1); assert.equal((await rpc('run', { runId })).report.usage.totals.totalTokens, 240);
  assert.equal(fixture.stats.collaborationUpgrades, 0, 'Collaboration must not use WebSocket for presence or messaging');
  await client!.rpc('pluginManager/setBundleEnabled', { name: 'dsh-p2p-collab', enabled: false });
  checks.push('HTTP-only collaboration works with WebSocket rejected; cold restart preserves identity, results and subscriptions without another model call; plugin disables live');
} catch (error) { failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  client?.close(); await runtime.stop(); await fixture.close(); await new Promise<void>(resolve => model.close(() => resolve()));
  await writeFile(join(data, 'host.log'), logs, { mode: 0o600 });
  const report = { status: failure ? 'failed' : 'pass', failure, checks, modelCalls, data };
  await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
