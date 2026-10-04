// Run with services/relay/node_modules/.bin/tsx. The two packaged test apps
// load tests/collaboration-cross-host.cjs and reach this loopback controller
// through a temporary SSH reverse tunnel on ubuntu160.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { collaborationFixture } from '../services/relay/test/collab-fixture.ts';

const data = resolve(process.env.DSH_CROSS_REPORT_DIR ?? '.test-data/collab-cross-host-20261003');
await mkdir(data, { recursive: true });
const fixture = await collaborationFixture({ rejectCollaborationWebSocket: true });
type Peer = 'mac' | 'ubuntu160';
const ready = new Map<string, unknown>(), queues = new Map<Peer, any[]>([['mac', []], ['ubuntu160', []]]);
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const checks: string[] = [], errors: string[] = [];
const registrationCodes = new Map<Peer, string>();
const controller = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://127.0.0.1');
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) throw new Error('Oversized fixture response'); }
    const body = raw ? JSON.parse(raw) : {};
    let value: unknown = {};
    if (url.pathname === '/config') {
      const peer = url.searchParams.get('peer') as Peer;
      if (!queues.has(peer)) throw new Error('Unknown test peer');
      if (!registrationCodes.has(peer)) registrationCodes.set(peer, fixture.relayStore.registration('fixture@example.test'));
      value = { relay: fixture.origin, code: registrationCodes.get(peer) };
    }
    else if (url.pathname === '/ready') ready.set(body.peer, body);
    else if (url.pathname === '/next') value = queues.get(url.searchParams.get('peer') as Peer)?.shift() ?? {};
    else if (url.pathname === '/result') {
      const operation = pending.get(body.id); pending.delete(body.id);
      if (operation) body.error ? operation.reject(new Error(body.error)) : operation.resolve(body.value);
    } else if (url.pathname === '/failure') errors.push(body.peer + ': ' + body.error);
    else { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
await new Promise<void>(r => controller.listen(0, '127.0.0.1', r));
const port = (controller.address() as any).port;
await writeFile(join(data, 'controller.json'), JSON.stringify({ port, relayPort: Number(new URL(fixture.origin).port), origin: `http://127.0.0.1:${port}`, data }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ waitingFor: ['mac', 'ubuntu160'], metadata: join(data, 'controller.json') }));
const wait = async <T>(check: () => Promise<T | false>, message: string, timeout = 45000): Promise<T> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (errors.length) throw new Error(errors.join('\n'));
    const value = await check(); if (value) return value;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(message);
};
const command = (peer: Peer, body: object) => new Promise<any>((resolve, reject) => {
  const id = randomUUID();
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(peer + ' command timeout')); }, 45000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  queues.get(peer)!.push({ id, ...body });
});
const rpc = (peer: Peer, method: string, args: object = {}) => command(peer, { type: 'rpc', method, args });
const stats = (peer: Peer) => command(peer, { type: 'stats' });
const state = (peer: Peer) => rpc(peer, 'sync');
const attempt = async (peer: Peer, id: string) => (await state(peer)).attempts.find((value: any) => value.id === id);
const settled = (peer: Peer, id: string, status: string) => wait(async () => { const value = await attempt(peer, id); return value?.status === status && value; }, `${peer}: attempt never reached ${status}`);
const plans = (peer: Peer, values: object[]) => command(peer, { type: 'plans', plans: values });
let failure: string | undefined;
try {
  await wait(async () => ready.size === 2 && true, 'Both isolated app copies must become ready', 240000);
  assert.equal((ready.get('mac') as any).platform, 'darwin');
  assert.equal((ready.get('ubuntu160') as any).platform, 'linux');
  assert.ok((ready.get('mac') as any).data.startsWith('/Users/'));
  assert.ok((ready.get('ubuntu160') as any).data.startsWith('/home/yyf/'));
  checks.push('Installed Mac and ubuntu160 Electron app copies loaded the updated code with separate test profiles and registered to the same isolated relay');
  const task = await rpc('mac', 'create', { operationId: randomUUID(), title: '跨 Mac 与 Ubuntu 的候选验证', description: 'Compare independent results and verify the candidate artifact.', acceptance: 'The corrected artifact contains 43 and its SHA-256 matches.' });
  await rpc('ubuntu160', 'follow', { taskId: task.id, following: true });
  await rpc('ubuntu160', 'reply', { taskId: task.id, operationId: randomUUID(), kind: 'message', body: 'UBUNTU_COMMENT_ONLY', baseRevision: 1 });
  assert.equal((await rpc('ubuntu160', 'catalog', { view: 'participating' })).tasks.length, 0);
  assert.equal((await stats('ubuntu160')).modelCalls, 0);
  checks.push('Following and commenting across hosts invoke no model and do not register an exploration');

  await plans('ubuntu160', [{ action: 'ready', summary: 'Initial candidate with reproducible result 42.', body: 'UBUNTU_CANDIDATE_V1', contribution: true, files: [{ name: 'result.txt', text: '42\n' }] }]);
  const first = await rpc('ubuntu160', 'start', { operationId: randomUUID(), taskId: task.id, mode: 'solve', executionMode: 'continuous', publishMode: 'auto', maxTokens: 4000, maxMinutes: 10, publicDirection: 'Ubuntu 独立实现', instruction: 'PRIVATE_UBUNTU_INSTRUCTION' });
  await settled('ubuntu160', first.attemptId, 'submitted');
  const initial = (await rpc('mac', 'candidates', { taskId: task.id })).items[0];
  assert.equal(initial.body, 'UBUNTU_CANDIDATE_V1');
  const publicDetail = await rpc('mac', 'detail', { taskId: task.id });
  assert.equal(publicDetail.attempts[0].direction, 'Ubuntu 独立实现');
  assert.ok(!JSON.stringify(publicDetail).includes('PRIVATE_UBUNTU_INSTRUCTION'));

  await plans('mac', [{ action: 'wait', summary: 'Candidate read; awaiting an independent counterexample.', contribution: false }]);
  const macRun = await rpc('mac', 'start', { operationId: randomUUID(), taskId: task.id, mode: 'solve', executionMode: 'continuous', publishMode: 'auto', maxTokens: 4000, maxMinutes: 10, publicDirection: 'Mac 独立复核', instruction: 'PRIVATE_MAC_INSTRUCTION' });
  await settled('mac', macRun.attemptId, 'waiting');
  const evidence = (await command('mac', { type: 'evidence', runId: macRun.id })).attachments.find((file: any) => file.name === 'result.txt');
  assert.equal(evidence.text, '42\n'); assert.equal(evidence.sourceReplyId, initial.id);
  assert.equal(evidence.sha256, createHash('sha256').update(evidence.text).digest('hex'));
  assert.equal((await rpc('mac', 'detail', { taskId: task.id })).task.replyCount, 2);
  checks.push('The Mac app reads the Ubuntu candidate artifact with verified bytes and source reply; private instructions stay private and a no-change review posts nothing');

  await plans('ubuntu160', [{ action: 'ready', summary: 'Counterexample changes the answer to 43.', body: 'UBUNTU_CANDIDATE_V2', contribution: true, files: [{ name: 'result.txt', text: '43\n' }] }]);
  await rpc('mac', 'reply', { taskId: task.id, operationId: randomUUID(), kind: 'message', body: 'MAC_COUNTEREXAMPLE: expected 43', baseRevision: 1 });
  await wait(async () => { const result = await rpc('mac', 'candidates', { taskId: task.id }); return result.items[0]?.body === 'UBUNTU_CANDIDATE_V2' && result; }, 'The Ubuntu app did not revise its candidate');
  const candidates = await rpc('mac', 'candidates', { taskId: task.id });
  assert.equal(candidates.total, 1); const revised = candidates.items[0]; assert.equal(revised.replaces, initial.id);
  await wait(async () => { const value = await attempt('mac', macRun.attemptId); return value.status === 'waiting' && !value.pendingEvents.length && value; }, 'Mac review did not settle after new evidence');
  const count = (await rpc('mac', 'detail', { taskId: task.id })).task.replyCount;
  assert.equal(count, 4);
  await new Promise(r => setTimeout(r, 7000));
  assert.equal((await rpc('ubuntu160', 'detail', { taskId: task.id })).task.replyCount, count);
  checks.push('A cross-host counterexample creates a linked candidate revision; the index keeps one current candidate and local no-change reviews do not produce a message loop');

  await rpc('mac', 'attempt-pause', { attemptId: macRun.attemptId });
  await rpc('ubuntu160', 'attempt-pause', { attemptId: first.attemptId });
  await wait(async () => (await rpc('mac', 'detail', { taskId: task.id })).attempts.every((value: any) => value.status === 'paused'), 'Public pause states did not synchronize');
  const before = { mac: (await stats('mac')).modelCalls, ubuntu160: (await stats('ubuntu160')).modelCalls };
  const reviewedBefore = (await attempt('ubuntu160', first.attemptId)).reviewedCursor;
  let lastReply: any;
  for (let index = 0; index < 53; index++) lastReply = await fixture.call(2, `tasks/${task.id}/replies`, { operationId: randomUUID(), actor: 'user', kind: 'message', body: `PAGE_TWO_EVIDENCE_${index}`, baseRevision: 1 });
  const focused = await rpc('ubuntu160', 'detail', { taskId: task.id, subjectId: lastReply.id });
  assert.equal(focused.replyOffset, 50); assert.ok(focused.replies.some((reply: any) => reply.id === lastReply.id));
  const unreadBefore = (await state('ubuntu160')).unread;
  const inboxBefore = await rpc('ubuntu160', 'inbox');
  const targetEvent = inboxBefore.items.find((item: any) => item.subjectId === lastReply.id);
  assert.ok(targetEvent && !targetEvent.read);
  await command('ubuntu160', { type: 'inbox-latest', expected: 'PAGE_TWO_EVIDENCE_52' });
  const inboxAfter = await wait(async () => {
    const value = await rpc('ubuntu160', 'inbox');
    return value.items.some((item: any) => item.id === targetEvent.id && item.read) && value;
  }, 'The opened event was not marked read');
  for (const event of inboxBefore.items.filter((item: any) => !item.read && item.id !== targetEvent.id)) assert.equal(inboxAfter.items.find((item: any) => item.id === event.id)?.read, false);
  const unreadAfter = (await state('ubuntu160')).unread;
  assert.equal(unreadAfter, unreadBefore - 1);
  await new Promise(r => setTimeout(r, 4000));
  assert.equal((await stats('mac')).modelCalls, before.mac); assert.equal((await stats('ubuntu160')).modelCalls, before.ubuntu160);
  const paused = await attempt('ubuntu160', first.attemptId);
  assert.equal(paused.desiredState, 'paused'); assert.equal(paused.reviewedCursor, reviewedBefore);
  assert.ok(paused.pendingEvents.some((event: any) => event.subjectId === lastReply.id));
  checks.push('The Ubuntu UI opens a real second-page inbox contribution and marks only that event read; both paused apps retain updates without another model call');

  const bytes = Buffer.from((await rpc('mac', 'download', { id: revised.attachments[0].id })).data, 'base64');
  assert.equal(bytes.toString(), '43\n'); assert.equal(createHash('sha256').update(bytes).digest('hex'), revised.attachments[0].sha256);
  const validation = await rpc('mac', 'validate', { taskId: task.id, operationId: randomUUID(), replyId: revised.id, baseRevision: 1, outcome: 'passed', method: 'Read candidate bytes and compare SHA-256 and expected value', environment: 'Mac app / Ubuntu app, isolated relay, deterministic model', evidence: 'Verified UTF-8 bytes 43\\n and matching SHA-256' });
  const detail = await rpc('mac', 'detail', { taskId: task.id });
  assert.equal((await rpc('mac', 'accept', { taskId: task.id, operationId: randomUUID(), replyId: revised.id, revision: detail.task.revision, validationId: validation.id })).status, 'resolved');
  assert.equal((await rpc('ubuntu160', 'detail', { taskId: task.id })).task.status, 'resolved');
  checks.push('The task author on Mac verifies the revised Ubuntu artifact, records validation, and accepts it; the Ubuntu app observes the resolved task');
  for (const peer of ['mac', 'ubuntu160'] as const) await command(peer, { type: 'capture' });
} catch (error) { failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  const nodes = Object.fromEntries(ready);
  for (const peer of ['mac', 'ubuntu160'] as const) if (ready.has(peer)) await command(peer, { type: 'quit' }).catch(() => {});
  const report = { status: failure ? 'failed' : 'pass', failure, checks, nodes, data, model: 'deterministic local fixture; no external model used' };
  await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await fixture.close(); controller.closeAllConnections(); await new Promise<void>(r => controller.close(() => r()));
}
