import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexRuntime, deriveCodexUsage } from '../src/codex-runtime.ts';
import { collectCollabUsage, settledCollabTokens, collabOutput } from '../../../src/runtime/collab-usage.ts';

export const fakeOptions = { command: process.execPath, args: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))] };
async function waitFor(fn: () => boolean) { const until = Date.now() + 3000; while (!fn()) { if (Date.now() > until) throw new Error('fixture timeout'); await new Promise(r => setTimeout(r, 10)); } }
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'codex-runtime-')), runtime = new CodexRuntime(home, fakeOptions); await runtime.restore();
  const { sessionId } = await runtime.create({});
  return { runtime, sessionId, home, close: async () => { await runtime.stop(); await rm(home, { recursive: true, force: true }); } };
}
test('Codex fast completion, duplicate usage, continuation and private durable history', async () => {
  const f = await fixture();
  try {
    await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'FAST' }] });
    assert.equal(f.runtime.session(f.sessionId).status, 'idle');
    assert.equal(collabOutput(await f.runtime.inspect(f.sessionId)), 'Codex fixture 中文 result');
    await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'next round' }] });
    await waitFor(() => f.runtime.session(f.sessionId).status === 'idle');
    const inspections = [await f.runtime.inspect(f.sessionId)];
    assert.equal(settledCollabTokens(inspections, deriveCodexUsage), 28);
    const usage = collectCollabUsage(inspections, deriveCodexUsage);
    assert.equal(usage.status, 'complete'); assert.equal(usage.totals.uncachedInputTokens, 16); assert.equal(usage.totals.cacheReadTokens, 4);
    await f.runtime.flush(); assert.equal(JSON.parse(await readFile(join(f.home, 'sessions.json'), 'utf8')).sessions.length, 1);
  } finally { await f.close(); }
});
test('missing usage stays unavailable and workspace escape is rejected', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.runtime.create({ cwd: tmpdir() }), /inside/);
    await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'NO_USAGE FAST' }] });
    const usage = collectCollabUsage([await f.runtime.inspect(f.sessionId)], deriveCodexUsage);
    assert.equal(usage.status, 'unavailable'); assert.equal(usage.totals.totalTokens, null);
  } finally { await f.close(); }
});
test('approvals and questions are scoped; cancellation retires old requests', async () => {
  const f = await fixture();
  try {
    await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'APPROVAL' }] });
    await waitFor(() => f.runtime.pending.size === 1); const request = [...f.runtime.pending.values()][0];
    assert.throws(() => f.runtime.answer(request.id, { decision: 'acceptForSession' }), /request only/);
    f.runtime.answer(request.id, { decision: 'accept' }); await waitFor(() => f.runtime.session(f.sessionId).status === 'idle');
    assert.throws(() => f.runtime.answer(request.id, { decision: 'accept' }), /expired/);
    await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'QUESTION' }] });
    await waitFor(() => f.runtime.pending.size === 1); const question = [...f.runtime.pending.values()][0];
    assert.throws(() => f.runtime.answer(question.id, { answers: {} }), /Each question/);
    await f.runtime.cancel({ sessionId: f.sessionId }); await waitFor(() => f.runtime.pending.size === 0);
    assert.throws(() => f.runtime.answer(question.id, { answers: { choice: { answers: ['A'] } } }), /expired/);
  } finally { await f.close(); }
});
test('restart preserves an interrupted run and never replays a prompt automatically', async () => {
  const f = await fixture();
  try {
    await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'WAIT' }] });
    await f.runtime.stop();
    const restored = new CodexRuntime(f.home, fakeOptions); await restored.restore();
    assert.equal(restored.session(f.sessionId).status, 'idle');
    const inspection = await restored.inspect(f.sessionId);
    assert.equal(inspection.events.at(-1).data.reason, 'interrupted');
    assert.equal(restored.app.generation, 0); await restored.stop();
  } finally { await f.close(); }
});
test('retried prompt IDs execute once and reject changed payloads', async () => {
  const f = await fixture();
  try {
    const prompt = { sessionId: f.sessionId, requestId: 'same-prompt-id', content: [{ type: 'text', text: 'FAST' }] };
    const first = await f.runtime.prompt(prompt); assert.deepEqual(await f.runtime.prompt(prompt), first);
    assert.equal((await f.runtime.inspect(f.sessionId)).events.filter(e => e.type === 'turn/start').length, 1);
    await assert.rejects(() => f.runtime.prompt({ ...prompt, content: [{ type: 'text', text: 'different' }] }), /different prompt/);
  } finally { await f.close(); }
});
test('file receipts are session-scoped, immutable and consumed by one idempotent prompt', async () => {
  const f = await fixture();
  try {
    const receipt = await f.runtime.upload(f.sessionId, Buffer.from('private fixture'), 'input.txt');
    const other = await f.runtime.create({});
    await assert.rejects(() => f.runtime.prompt({ sessionId: other.sessionId, content: [{ type: 'file', receiptId: receipt.receiptId }] }), /another session/);
    const prompt = { sessionId: f.sessionId, requestId: 'uploaded-input', content: [{ type: 'text', text: 'FAST' }, { type: 'file', receiptId: receipt.receiptId }] };
    const result = await f.runtime.prompt(prompt); assert.deepEqual(await f.runtime.prompt(prompt), result);
    await assert.rejects(() => f.runtime.prompt({ ...prompt, requestId: 'reused-input' }), /unavailable/);
    const link = join(f.home, 'collaboration/workspaces', 'escape'); await symlink(tmpdir(), link);
    await assert.rejects(() => f.runtime.create({ cwd: join(link, 'must-not-create') }), /symlink/);
  } finally { await f.close(); }
});
test('bridge model preference persists without changing other native settings', async () => {
  const f = await fixture();
  try {
    await f.runtime.configureModel('fixture-model'); await f.runtime.stop();
    const restored = new CodexRuntime(f.home, fakeOptions); await restored.restore();
    assert.equal(restored.defaultModel, 'fixture-model');
    assert.deepEqual(await restored.selectModel({ sessionId: f.sessionId, model: 'other-fixture', reasoningEffort: 'low' }), { selected: { provider: 'codex', model: 'other-fixture', reasoningEffort: 'low' } });
    await restored.stop();
  } finally { await f.close(); }
});
test('early child events wait for proven parentage and unrelated threads stay outside accounting', async () => {
  const f = await fixture();
  try {
    await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'FAST' }] });
    const note = (method: string, params: any) => f.runtime.app.emit('notification', { method, params });
    const threadId = 'owned-child', turnId = 'child-turn';
    note('turn/started', { threadId, turn: { id: turnId } });
    note('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 5 } } });
    note('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    assert.equal(f.runtime.sessions.size, 1);
    note('thread/started', { thread: { id: threadId, parentThreadId: f.runtime.session(f.sessionId).threadId } });
    assert.equal(f.runtime.sessions.size, 2);
    const child = [...f.runtime.sessions.values()].find(s => s.parentSession === f.sessionId)!;
    assert.equal(child.status, 'idle'); assert.equal(settledCollabTokens([await f.runtime.inspect(f.sessionId), await f.runtime.inspect(child.id)], deriveCodexUsage), 19);
    note('thread/started', { thread: { id: 'other-child', parentThreadId: 'unrelated-thread' } });
    assert.equal(f.runtime.sessions.size, 2);
  } finally { await f.close(); }
});
test('late errors and completion from an older turn do not affect the active turn', async () => {
  const f = await fixture();
  try {
    const first = await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'FAST' }] });
    await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'SLOW' }] });
    const session = f.runtime.session(f.sessionId), currentTurn = session.activeTurn;
    f.runtime.app.emit('notification', { method: 'error', params: { threadId: session.threadId, turnId: first.turnId, willRetry: false, error: { message: 'old error' } } });
    f.runtime.app.emit('notification', { method: 'turn/completed', params: { threadId: session.threadId, turn: { id: first.turnId, status: 'failed', error: { message: 'old failure' } } } });
    assert.equal(session.activeTurn, currentTurn); assert.equal(session.error, undefined);
    await waitFor(() => session.status === 'idle');
    assert.equal((await f.runtime.inspect(f.sessionId)).events.at(-1).data.error, undefined);
  } finally { await f.close(); }
});
test('phone images and files remain visible in durable history with session-scoped image reads', async () => {
  const f = await fixture();
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
  try {
    const receipt = await f.runtime.upload(f.sessionId, Buffer.from('phone note'), 'note.txt');
    await f.runtime.prompt({ sessionId: f.sessionId, content: [{ type: 'text', text: 'FAST' }, { type: 'image', mediaType: 'image/png', data, name: 'pixel.png' }, { type: 'file', receiptId: receipt.receiptId }] });
    const parts = f.runtime.session(f.sessionId).wireEvents!.find(e => e.type === 'user/message').data.content;
    assert.deepEqual(parts.map((p: any) => p.type), ['text', 'image', 'file']);
    assert.equal(parts[1].attachment.width, 1); assert.equal(parts[1].attachment.height, 1);
    assert.equal(parts[2].attachment.name, 'note.txt');
    assert.equal((await (f.runtime as any).attachment(f.sessionId, parts[1].attachment.attachmentId)).data, data);
    const other = await f.runtime.create({});
    await assert.rejects(() => (f.runtime as any).attachment(other.sessionId, parts[1].attachment.attachmentId), /not referenced/);
    await f.runtime.stop(); const restored = new CodexRuntime(f.home, fakeOptions); await restored.restore();
    assert.equal((await (restored as any).attachment(f.sessionId, parts[1].attachment.attachmentId)).data, data); await restored.stop();
  } finally { await f.close(); }
});
