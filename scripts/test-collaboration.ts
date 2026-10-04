import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
type ModelPlan = { action: 'continue' | 'wait' | 'ready'; summary: string; nextStep?: string; hold?: Promise<void> };
const modelPlans = new Map<string, ModelPlan[]>(), modelInputs: { taskId: string; runId: string; text: string }[] = [];
const model = createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'deepseek-flash', object: 'model' }] })); return; }
  if (!req.url?.endsWith('/messages')) { res.writeHead(404); res.end('{}'); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body); modelCalls++;
  // Drive the real Host/runtime with a deterministic model and disposable files only.
  const profile = JSON.parse(await readFile(join(state, 'collaboration/profile.json'), 'utf8'));
  const current = Object.values(profile.runs).sort((a: any, b: any) => b.startedAt - a.startedAt)[0] as any;
  const plan = modelPlans.get(current.taskId)?.shift() ?? { action: 'ready', summary: 'Deterministic evidence is ready for review.' };
  modelInputs.push({ taskId: current.taskId, runId: current.id, text: JSON.stringify(input) });
  if (plan.hold) await plan.hold;
  const cwd = join(state, 'collaboration/workspaces', current.id);
  await writeFile(join(cwd, 'continuation.json'), JSON.stringify({ action: plan.action, summary: plan.summary, nextStep: plan.nextStep ?? '',
    wakeOn: plan.action === 'wait' ? ['reply.created', 'solution.submitted', 'task.updated'] : [],
    decisions: (current.triggerEventIds ?? []).map((eventId: number) => ({ eventId, decision: 'verify', reason: 'Evaluate the new counterexample in this isolated stage.' })) }));
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
  assert.equal(detail.task.status, 'open', 'A candidate must not end open exploration');
  const validation = await fixture.call(0, `tasks/${taskId}/validations`, { operationId: randomUUID(), replyId: reply.id, baseRevision: detail.task.specRevision,
    outcome: 'passed', method: 'Assert exact token totals', environment: 'Isolated local deterministic model', evidence: '128 + 64 + 16 + 32 = 240 verified from runtime report' });
  assert.equal((await fixture.call(0, `tasks/${taskId}/accept`, { operationId: randomUUID(), revision: detail.task.revision, replyId: reply.id, validationId: validation.id })).status, 'resolved');
  await rpc('sync'); assert.ok((await rpc('state')).unread > 0, 'Author acceptance did not reach subscribed desktop');
  checks.push('Browse/follow use no model; explicit solve invokes one mock call; exact usage is 240; a reviewed candidate keeps the task open and author accepts only with attached validation');
  client!.close(); client = undefined; await runtime.stop(); await start();
  const restored = await rpc('sync');
  assert.equal(restored.peer.id, stateValue.peer.id); assert.equal((await rpc('detail', { taskId })).task.status, 'resolved');
  assert.equal(modelCalls, 1); assert.equal((await rpc('run', { runId })).report.usage.totals.totalTokens, 240);
  assert.equal(fixture.stats.collaborationUpgrades, 0, 'Collaboration must not use WebSocket for presence or messaging');

  const createTask = (title: string) => fixture.call(0, 'tasks', { operationId: randomUUID(), title, description: 'Explore independently and evaluate counterexamples.', acceptance: 'Record evidence and stop at a reviewable candidate.' });
  const localAttempt = async (id: string) => (await rpc('state')).attempts.find((attempt: any) => attempt.id === id);
  const awaitAttempt = (id: string, status: string) => wait(async () => { const a = await localAttempt(id); return a?.status === status && a; }, `Attempt never entered ${status}`);
  const peerReply = (id: string, body: string, attachments: string[] = []) => fixture.call(2, `tasks/${id}/replies`, { operationId: randomUUID(), actor: 'user', kind: 'message', body, baseRevision: 1, attachments });
  await rpc('profile', { nickname: stateValue.peer.nickname, maxTokens: 2000, maxMinutes: 10, publishMode: 'manual', executionMode: 'continuous' });

  // Evidence arrives while the model is active. Only the next completed-run checkpoint may consume it.
  const activeTask = await createTask('运行中收到反证'), activeStart = modelCalls;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  modelPlans.set(activeTask.id, [{ action: 'continue', summary: 'Initial reproduction is complete.', nextStep: 'Evaluate the counterexample against the reproduction.', hold }, { action: 'ready', summary: 'Counterexample verified and incorporated.' }]);
  const activeRun = await rpc('start', { operationId: randomUUID(), taskId: activeTask.id, mode: 'solve', executionMode: 'continuous', instruction: 'PRIVATE_LOCAL_DIRECTION: Evaluate evidence in bounded stages.' });
  await wait(async () => modelInputs.some(i => i.runId === activeRun.id), 'Initial model stage did not start');
  try {
    const evidence = await fixture.call(2, 'attachments', { operationId: randomUUID(), name: 'counterexample.txt', data: Buffer.from('COUNTEREXAMPLE_ARTIFACT_BYTES\n').toString('base64') });
    await peerReply(activeTask.id, 'COUNTEREXAMPLE_DURING_ACTIVE_RUN', [evidence.id]); await rpc('sync');
    const pending = await localAttempt(activeRun.attemptId);
    assert.equal(modelCalls, activeStart + 1); assert.equal(pending.runIds.length, 1);
    assert.ok(pending.pendingEvents.length > 0); assert.ok(pending.reviewedCursor < pending.receivedCursor);
    assert.doesNotMatch(JSON.stringify((await fixture.call(0, 'tasks/' + activeTask.id)).attempts), /PRIVATE_LOCAL_DIRECTION/, 'Participation updates must not publish private instructions');
  } finally { release(); }
  const ready = await awaitAttempt(activeRun.attemptId, 'ready');
  assert.equal(ready.runIds.length, 2); assert.equal(modelCalls, activeStart + 2); assert.equal(ready.usedTokens, 480);
  assert.ok(ready.decisions.length); assert.equal(ready.pendingEvents.length, 0);
  assert.match(modelInputs.find(i => i.runId === ready.runIds[1])!.text, /COUNTEREXAMPLE_DURING_ACTIVE_RUN/);
  const evidenceRequest = JSON.parse(await readFile(join(state, 'collaboration/workspaces', ready.runIds[1], 'task.json'), 'utf8'));
  const evidenceFile = evidenceRequest.discussion.find((reply: any) => reply.body === 'COUNTEREXAMPLE_DURING_ACTIVE_RUN').attachments[0];
  assert.ok(evidenceFile.path, 'A supplied contribution artifact must be readable in the next stage');
  assert.equal(await readFile(join(state, 'collaboration/workspaces', ready.runIds[1], evidenceFile.path), 'utf8'), 'COUNTEREXAMPLE_ARTIFACT_BYTES\n');
  assert.ok(!modelInputs.find(i => i.runId === ready.runIds[1])!.text.includes(fixture.tokens[1]), 'Relay credentials must remain outside model context');
  assert.equal((await fixture.call(0, 'tasks/' + activeTask.id)).replies.length, 1, 'Manual publication must keep both AI stages local');
  checks.push('Active-stage counterevidence and its checked artifact reach a second independent run at a checkpoint without relay credentials; decisions and cumulative 480 tokens persist; manual publication uploads no AI result');
  await peerReply(activeTask.id, 'COUNTEREXAMPLE_AFTER_CANDIDATE_READY'); await rpc('sync');
  const reevaluated = await wait(async () => { const a = await localAttempt(activeRun.attemptId); return a.status === 'ready' && a.runIds.length === 3 && a; }, 'A ready continuous participant did not evaluate new counterevidence');
  assert.equal(reevaluated.usedTokens, 720); assert.equal(modelCalls, activeStart + 3);
  assert.match(modelInputs.find(i => i.runId === reevaluated.runIds[2])!.text, /COUNTEREXAMPLE_AFTER_CANDIDATE_READY/);
  await fixture.call(0, 'tasks/' + activeTask.id, { operationId: randomUUID(), revision: activeTask.revision, status: 'closed' }); await rpc('sync');
  await awaitAttempt(activeRun.attemptId, 'completed'); assert.equal(modelCalls, activeStart + 3);
  checks.push('A ready continuous participant evaluates a later counterexample in another run; task closure then ends participation without another model call');

  const pauseTask = await createTask('等待与持久暂停'), pauseStart = modelCalls;
  modelPlans.set(pauseTask.id, [{ action: 'wait', summary: 'Waiting for a reproducible counterexample.' }, { action: 'ready', summary: 'New evidence verified after explicit resume.' }]);
  const waitingRun = await rpc('start', { operationId: randomUUID(), taskId: pauseTask.id, mode: 'solve', executionMode: 'continuous' });
  await awaitAttempt(waitingRun.attemptId, 'waiting');
  await rpc('attempt-pause', { attemptId: waitingRun.attemptId });
  await peerReply(pauseTask.id, 'COUNTEREXAMPLE_WHILE_USER_PAUSED'); await rpc('sync');
  assert.equal((await localAttempt(waitingRun.attemptId)).status, 'paused');
  client!.close(); client = undefined; await runtime.stop(); await start(); await rpc('sync');
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(modelCalls, pauseStart + 1); assert.equal((await localAttempt(waitingRun.attemptId)).desiredState, 'paused');
  assert.ok((await localAttempt(waitingRun.attemptId)).pendingEvents.length > 0);
  await rpc('attempt-resume', { attemptId: waitingRun.attemptId, nextStep: 'Evaluate the pending counterexample before continuing.' });
  const resumed = await awaitAttempt(waitingRun.attemptId, 'ready');
  assert.equal(resumed.runIds.length, 2); assert.equal(modelCalls, pauseStart + 2);
  assert.match(modelInputs.find(i => i.runId === resumed.runIds[1])!.text, /COUNTEREXAMPLE_WHILE_USER_PAUSED/);
  checks.push('Waiting participation accepts durable updates; user pause survives incoming evidence and a real runtime restart with no model wakeup; explicit resume consumes the evidence');

  const wakeTask = await createTask('等待条件自动唤醒'), wakeStart = modelCalls;
  modelPlans.set(wakeTask.id, [{ action: 'wait', summary: 'Waiting for another participant to supply reproduction.' }, { action: 'ready', summary: 'Reproduction supplied and checked.' }]);
  const wakeRun = await rpc('start', { operationId: randomUUID(), taskId: wakeTask.id, mode: 'solve', executionMode: 'continuous' });
  await awaitAttempt(wakeRun.attemptId, 'waiting');
  await peerReply(wakeTask.id, 'REPRODUCTION_WAKES_AUTHORIZED_WAIT'); await rpc('sync');
  const woken = await awaitAttempt(wakeRun.attemptId, 'ready');
  assert.equal(woken.runIds.length, 2); assert.equal(modelCalls, wakeStart + 2);
  checks.push('Authorized waiting participation wakes on a matching new contribution and stops at a reviewable candidate');

  await rpc('profile', { nickname: stateValue.peer.nickname, maxTokens: 240, maxMinutes: 10, publishMode: 'review', executionMode: 'continuous' });
  const budgetTask = await createTask('跨阶段预算'), budgetStart = modelCalls;
  modelPlans.set(budgetTask.id, [{ action: 'continue', summary: 'First experiment consumed the allocated budget.', nextStep: 'Run one more explicit verification.' }, { action: 'ready', summary: 'Verification completed with the added budget.' }]);
  const budgetRun = await rpc('start', { operationId: randomUUID(), taskId: budgetTask.id, mode: 'solve', executionMode: 'continuous' });
  await awaitAttempt(budgetRun.attemptId, 'budget');
  await peerReply(budgetTask.id, 'BUDGET_PAUSE_MUST_NOT_WAKE'); await rpc('sync');
  await assert.rejects(rpc('attempt-resume', { attemptId: budgetRun.attemptId }), /预算|阈值|限制/);
  assert.equal(modelCalls, budgetStart + 1);
  await rpc('attempt-resume', { attemptId: budgetRun.attemptId, additionalTokens: 500, nextStep: 'Verify with the additional explicit budget.' });
  const funded = await awaitAttempt(budgetRun.attemptId, 'ready');
  assert.equal(funded.usedTokens, 480); assert.equal(funded.limits.maxTokens, 740);
  checks.push('The cumulative token cap pauses before another stage; messages and bare resume cannot bypass it; an explicit 500-token extension permits the second stage');

  await client!.rpc('pluginManager/setBundleEnabled', { name: 'dsh-p2p-collab', enabled: false });
  checks.push('HTTP-only collaboration works with WebSocket rejected; cold restart preserves identity, results and subscriptions without another model call; plugin disables live');
} catch (error) { failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  client?.close(); await runtime.stop(); await fixture.close(); await new Promise<void>(resolve => model.close(() => resolve()));
  await writeFile(join(data, 'host.log'), logs, { mode: 0o600 });
  await writeFile(join(data, 'model-inputs.json'), JSON.stringify(modelInputs, null, 2), { mode: 0o600 });
  const report = { status: failure ? 'failed' : 'pass', failure, checks, modelCalls, data };
  await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
