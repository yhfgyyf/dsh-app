import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { connectFixture } from '../tests/fixture-client.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeRoot = resolve(process.env.DSH_TEST_DESKTOP_RUNTIME ?? join(root, '.runtime'));
await mkdir(join(root, '.test-data'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/auto-conversation-'));
const home = join(data, 'home');
const state = join(data, 'state');
await mkdir(home); await mkdir(state);
const requests: { phase: string; route: string }[] = [];
let nextVerdict = 'pass';
const mock = createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }));
    return;
  }
  if (!req.url?.endsWith('/messages')) { res.writeHead(404); res.end('{}'); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const texts = request.messages.flatMap((message: any) => typeof message.content === 'string' ? [message.content] : message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text));
  const route = texts.join('\n').match(/fixture-route:(standard|code|minimal|cordis)/)?.[1] ?? 'standard';
  const catalog = texts.find((text: string) => text.startsWith('Select from this JSON-framed capability catalog:'));
  const classify = texts.some((text: string) => text.startsWith('Classify this JSON-framed first user task:'));
  const candidates = catalog ? JSON.parse(catalog.slice(catalog.indexOf('\n') + 1)) : undefined;
  const review = texts.find((text: string) => text.includes('Return one JSON value matching this schema exactly:'));
  const audit = review?.includes('"required":["verdict"');
  const phase = review ? audit ? 'audit' : 'summary' : classify ? 'route' : catalog ? 'capabilities' : 'reply';
  const answer = review ? JSON.stringify(audit
    ? { verdict: nextVerdict, summary: 'Local fixture review', findings: nextVerdict === 'pass' ? [] : [{ severity: nextVerdict, message: 'Fixture remediation', suggestion: 'Reply AUTO_V4_OK without tool calls.' }] }
    : { intent: 'fixture', progress: 'completed', evidence: ['local test'], risks: [], next: [] })
    : classify ? route : catalog ? JSON.stringify({ tools: candidates.tools.slice(0, 1).map((tool: any) => tool.name), skills: [] }) : 'AUTO_V4_OK';
  if (audit) nextVerdict = 'pass';
  requests.push({ phase, route });
  const message = { id: randomUUID(), type: 'message', role: 'assistant', model: request.model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 128, output_tokens: 32 } };
  if (!request.stream) {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 128, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 32 } });
  emit('message_stop', {}); res.end();
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const port = (mock.address() as { port: number }).port;
await writeFile(join(state, 'desktop.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${port}\n    apiKeyEnv: DSH_DESKTOP_FIXTURE_KEY\n    maxTokens: 4096\n- id: audit-bundle\n  config:\n    reviewer: dsh\n    models:\n      summarizer: { model: deepseek-flash, effort: high }\n      auditor: { model: deepseek-flash, effort: high }\n`);
await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n');
process.env.DSH_DESKTOP_FIXTURE_KEY = 'desktop-local-fixture';
const core = new DesktopRuntime({ runtimeRoot, entry: join(runtimeRoot, 'app/index.ts'), home: state, configHome: home, cwd: data, onExit: () => {} });
let client: Awaited<ReturnType<typeof connectFixture>> | undefined;
const sessions: { id: string; preset: string }[] = [];
const checks: string[] = [];
let logs = '';
let failure: string | undefined;
const before = process.argv.includes('--expect-broken');
async function start() {
  const ready = await core.start();
  for (const stream of [core.child?.stdout, core.child?.stderr]) stream?.on('data', chunk => { logs += String(chunk); });
  const connection = join(data, 'connection.json');
  await writeFile(connection, JSON.stringify({ owner: 'dsh-desktop-test', ...ready }), { mode: 0o600 });
  client = await connectFixture(connection);
}
try {
  await start();
  for (const route of before ? ['standard'] : ['standard', 'code', 'minimal', 'cordis']) {
    const id = (await client!.rpc('session/create', { request: { cwd: data, agentPreset: 'auto' } })).sessionId;
    const session = client!.follow('session/follow', { request: { address: { kind: 'session', sessionId: id }, assistantStream: true } });
    try {
      await session.wait(frames => frames.some(frame => frame.type === 'snapshot'));
      await client!.rpc('session/prompt', { request: { sessionId: id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: `[fixture-route:${route}] Read this test request and reply AUTO_V4_OK. Do not call tools.` }] } });
      await session.wait(frames => logs.includes('format v4 message requires a producer-owned source kind') || frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end'), 20000);
      await writeFile(join(data, `frames-${route}.json`), JSON.stringify(session.frames, null, 2));
      const events = session.frames.filter(frame => frame.type === 'event').map(frame => frame.event);
      if (before) {
        assert.equal(events.find(event => event.type === 'turn/end')?.data.reason.error?.message, 'format v4 message requires a producer-owned source kind');
        checks.push('reproduced exact V4 source error on first Auto prompt in actual DesktopRuntime');
        break;
      }
      assert.doesNotMatch(logs, /format v4 message requires a producer-owned source kind/);
      const classified = events.find(event => event.type.endsWith('/classified'));
      assert.ok(classified, 'Auto routing event must be persisted');
      assert.ok(classified.data.toolHints.length > 0, 'Exercise capability followup, not just mode switching');
      const preset = route === 'code' ? 'ptc' : route;
      assert.equal(classified.data.finalPreset, preset);
      assert.ok(events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('AUTO_V4_OK')));
      assert.equal(events.find(event => event.type === 'turn/end').data.reason.kind, 'completed');
      const hint = events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).find(message => JSON.stringify(message.content).includes('<auto-capability-hints>'));
      assert.equal(hint?.source.kind, 'plugin:dsh-auto-preset-router');
      sessions.push({ id, preset });
      checks.push(`Auto -> ${preset}: first prompt, nonempty capability hints and completed reply`);
    } finally { session.close(); }
  }
  if (!before) {
    const id = (await client!.rpc('session/create', { request: { cwd: data, agentPreset: 'audit' } })).sessionId;
    const session = client!.follow('session/follow', { request: { address: { kind: 'session', sessionId: id } } });
    const auditApi = async (action: string, body?: object) => {
      const response = await fetch(client!.endpoint + '/api/audit/' + action, { method: body ? 'POST' : 'GET', headers: client!.headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    try {
      await session.wait(frames => frames.some(frame => frame.type === 'snapshot'));
      await client!.rpc('session/prompt', { request: { sessionId: id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Audit fixture: reply AUTO_V4_OK without tools.' }] } });
      await session.wait(frames => frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end'));
      for (const verdict of ['warning', 'critical']) {
        nextVerdict = verdict;
        const reviewed = await auditApi('request-now', { sessionId: id });
        assert.equal(reviewed.view.lastVerdict, verdict, JSON.stringify(reviewed));
        assert.equal(reviewed.view.pendingApproval.status, 'pending');
        const priorTurns = session.frames.filter(frame => frame.type === 'event' && frame.event.type === 'turn/end').length;
        await auditApi('accept', { sessionId: id, auditId: reviewed.view.pendingApproval.auditId, editedText: 'Reply AUTO_V4_OK without tool calls.' });
        const started = Date.now();
        let view;
        do {
          view = await auditApi('snapshot?session=' + id);
          if (view.remediation?.phase === 'completed') break;
          assert.ok(Date.now() - started < 15000, JSON.stringify(view));
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (true);
        assert.equal(view.lastVerdict, 'pass');
        // A verified repair also queues continuation of the original task.
        // Wait for that turn's final audit before requesting another review.
        await session.wait(frames => frames.filter(frame => frame.type === 'event' && frame.event.type === 'turn/end').length >= priorTurns + 2);
        checks.push(`Audit ${verdict}: DSH review, explicit acceptance, remediation turn and verification complete`);
      }
      const events = session.frames.filter(frame => frame.type === 'event').map(frame => frame.event);
      assert.equal(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'), true);
      const messages = events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []);
      assert.ok(messages.filter(message => message.source.kind === 'plugin:dsh-audit-mode').length >= 2);
      await writeFile(join(data, 'frames-audit.json'), JSON.stringify(session.frames, null, 2));
      sessions.push({ id, preset: 'audit' });
    } finally { session.close(); }
    client!.close(); client = undefined; await core.stop(); await start();
    for (const { id, preset } of sessions) {
      const history = client!.follow('session/follow', { request: { address: { kind: 'session', sessionId: id } } });
      try {
        await history.wait(frames => frames.some(frame => frame.type === 'snapshot'));
        const snapshot = history.frames.find(frame => frame.type === 'snapshot');
        assert.equal(snapshot.projections.values.agentPreset, preset);
        assert.match(JSON.stringify(snapshot.records), /AUTO_V4_OK/);
      } finally { history.close(); }
    }
    checks.push('Auto and Audit conversations reopen with saved replies after a cold restart');
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(error); process.exitCode = 1;
} finally {
  client?.close(); await core.stop();
  await new Promise<void>(resolve => mock.close(() => resolve()));
  await mkdir(join(root, 'docs/evidence'), { recursive: true });
  const report = { at: new Date().toISOString(), status: failure ? 'failed' : 'pass', failure, runtimeRoot, data, checks, requests, scope: 'Actual isolated DesktopRuntime with local deterministic Messages endpoint; no external model or user session writes' };
  await writeFile(join(root, `docs/evidence/auto-conversation${before ? '-before' : ''}.json`), JSON.stringify(report, null, 2));
  await writeFile(join(data, 'core.log'), logs, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
