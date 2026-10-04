import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CollabClient } from '../src/runtime/collab-client.ts';
import { CollabHost } from '../src/runtime/collab-host.ts';

test('opening details and polling never call the model; an explicit start creates exactly one isolated session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-host-'));
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('offline fixture'); } });
  await client.restore(); const peerId = client.data.peerId;
  let created = 0, prompts = 0, cwd = '';
  const taskId = randomUUID();
  (client as any).api = async (path: string) => path === 'tasks/' + taskId ? { task: { id: taskId, title: 'Fixture', description: 'Task data', acceptance: 'Check', revision: 1, specRevision: 1, status: 'open' }, attempts: [], validations: [] } : { status: 'working' };
  const ctx: any = { agents: { get: () => ({ status: 'running', cancel() {} }) }, sessionController: {
    create: async (r: any) => { created++; cwd = r.cwd; return { sessionId: r.sessionId }; }, rename: async () => ({}),
    prompt: async (r: any, signal: AbortSignal) => { signal.throwIfAborted(); prompts++; assert.ok(r.content[0].text.includes('Task data')); return { accepted: true }; }, cancel: async () => ({}),
    inspect: async (id: string) => ({ meta: { id }, inheritedEventCount: 0, events: [] }),
  }, sessionPersistence: { flush: async () => {}, list: async () => [] } };
  const host = new CollabHost(client, ctx, () => undefined, { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' });
  const rpc = (method: string, args: object = {}) => host.handle(method, { args }, new AbortController().signal);
  try {
    assert.equal((await rpc('detail', { taskId })).ok, true);
    await rpc('state'); await rpc('state'); assert.equal(prompts, 0); assert.equal(created, 0);
    const operationId = randomUUID();
    const run = await rpc('start', { operationId, taskId, mode: 'solve' }); assert.equal(run.ok, true);
    assert.equal(created, 1); assert.equal(prompts, 1); assert.ok(cwd.startsWith(join(home, 'collaboration/workspaces')));
    await rpc('start', { operationId, taskId, mode: 'solve' }); assert.equal(prompts, 1);
    assert.equal((await rpc('start', { operationId: randomUUID(), taskId, mode: 'solve' })).ok, false);
    const restored = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error(); } }); await restored.restore();
    assert.equal(restored.data.peerId, peerId); assert.equal(restored.data.runs[operationId].taskId, taskId);
  } finally { await host.stop(); await rm(home, { recursive: true, force: true }); }
});

test('legacy relay details reject exploration before creating records or sessions while allowing discussion replies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-legacy-relay-'));
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('Fixture only'); } }); await client.restore();
  const taskId = randomUUID(), task = { id: taskId, title: 'Legacy task', description: 'Still discussable', acceptance: '', revision: 1, status: 'open' };
  const legacy = { task, replies: [], attachments: [] }, supported = { ...legacy, task: { ...task, specRevision: 1 }, attempts: [], validations: [] };
  let detail: any = legacy, created = 0, prompts = 0, writes = 0;
  client.sync = async () => {};
  client.api = async (_path, body) => { if (body !== undefined) writes++; return detail; };
  const ctx: any = { sessionController: { create: async () => { created++; }, rename: async () => {}, prompt: async () => { prompts++; } } };
  const host = new CollabHost(client, ctx, () => undefined, { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' });
  const rpc = (mode: 'reply' | 'solve') => host.handle('start', { args: { operationId: randomUUID(), taskId, mode } }, new AbortController().signal);
  try {
    const before = structuredClone(client.data), file = join(home, 'collaboration/profile.json'), bytesBefore = await readFile(file);
    for (detail of [legacy, ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(specRevision => ({ ...supported, task: { ...task, specRevision } })),
      { ...supported, attempts: undefined }, { ...supported, validations: undefined }]) {
      const result = await rpc('solve');
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.message, '中继尚未升级，暂不能启动独立探索；仍可浏览和讨论');
      assert.equal(created, 0); assert.equal(prompts, 0); assert.equal(writes, 0);
      assert.deepEqual(client.data, before); assert.deepEqual(await readFile(file), bytesBefore);
    }
    detail = legacy;
    assert.equal((await rpc('reply')).ok, true);
    assert.equal(created, 1); assert.equal(prompts, 1); assert.equal(writes, 0);
    assert.deepEqual(client.data.attempts, {}); assert.equal(Object.values(client.data.runs).length, 1);
    assert.equal(Object.values(client.data.runs)[0].mode, 'reply');
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

test('run limits remain fixed and cancellation stops only the run and its own descendants, including before turn/end', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-budget-'));
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('fixture'); } }); await client.restore();
  const taskId = randomUUID(), runId = randomUUID(), cancelled: string[] = [], agents = new Map<string, any>();
  let rootId = '';
  const childId = 'child-' + randomUUID();
  (client as any).api = async () => ({ task: { id: taskId, title: 'budget', description: 'fixture', acceptance: 'check', revision: 1, specRevision: 1, status: 'open' }, attempts: [], validations: [] });
  const live = (id: string) => ({ status: 'running', cancel() { cancelled.push(id); this.status = 'idle'; } });
  const ctx: any = { agents: { get: (id: string) => agents.get(id) }, sessionController: {
    create: async ({ sessionId }: any) => { rootId = sessionId; agents.set(rootId, live(rootId)); agents.set(childId, live(childId)); }, rename: async () => {}, prompt: async () => {},
    inspect: async (id: string) => ({ meta: { id }, inheritedEventCount: 0, events: [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 0 } },
      { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'partial output' }] } } }] }),
  }, sessionPersistence: { flush: async () => {}, list: async () => [{ header: { id: childId, parentSession: rootId, origin: 'subagent' } }, { header: { id: 'unrelated-child', parentSession: 'unrelated-root', origin: 'subagent' } }] } };
  const host = new CollabHost(client, ctx, () => ({ uncachedInputTokens: 500, outputTokens: 100, totalTokens: 600 }), { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' });
  const rpc = (method: string, args: object) => host.handle(method, { args }, new AbortController().signal);
  try {
    client.data.settings.maxTokens = 1000;
    assert.equal((await rpc('start', { operationId: runId, taskId, mode: 'solve' })).ok, true);
    client.data.settings.maxTokens = 10000;
    await Promise.all([rpc('run', { runId }), rpc('run', { runId })]);
    assert.equal(client.data.runs[runId].limits.maxTokens, 1000);
    assert.deepEqual(new Set(cancelled), new Set([rootId, childId]));
    assert.equal(client.data.runs[runId].status, 'stopped');
    assert.match(client.data.runs[runId].stopReason!, /Token/);
    assert.equal(client.data.runs[runId].report!.usage.status, 'unavailable');
    client.data.settings = { maxTokens: 0, maxMinutes: 0, executionMode: 'continuous' };
    const unlimitedId = randomUUID();
    const next = await rpc('start', { operationId: unlimitedId, taskId, mode: 'reply', executionMode: 'continuous' }); assert.equal(next.ok, true);
    assert.equal(client.data.runs[unlimitedId].limits.executionMode, 'manual');
    assert.equal(client.data.runs[unlimitedId].attemptId, undefined);
    client.data.runs[unlimitedId].startedAt = Date.now() - 40 * 24 * 60 * 60000;
    cancelled.length = 0;
    await rpc('run', { runId: unlimitedId });
    assert.equal(client.data.runs[unlimitedId].status, 'running');
    assert.deepEqual(cancelled, [], 'Zero limits must not immediately cancel long-running agents');
  } finally { await host.stop(); await rm(home, { recursive: true, force: true }); }
});

test('oversized attachments are rejected before a relay request with a download-link suggestion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-upload-'));
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('No upload expected'); } }); await client.restore();
  let requests = 0; client.api = async () => { requests++; return {}; };
  const host = new CollabHost(client, {} as any, () => undefined, { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' });
  try {
    const result = await host.handle('upload', { args: { operationId: randomUUID(), name: 'large.zip', data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') } }, new AbortController().signal);
    assert.equal(result.ok, false); assert.equal(requests, 0);
    if (!result.ok) { assert.match(result.error.message, /8 MiB/); assert.match(result.error.message, /下载链接/); }
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

test('large and unlimited local budgets save without a relay request, persist, and reject invalid values clearly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-settings-'));
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('No network for local settings'); } });
  await client.restore();
  let requests = 0;
  client.api = async () => { requests++; throw new Error('offline fixture'); };
  const host = new CollabHost(client, {} as any, () => undefined, { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' });
  const save = (maxTokens: unknown, maxMinutes: unknown) => host.handle('profile', { args: { nickname: client.data.nickname, maxTokens, maxMinutes } }, new AbortController().signal);
  try {
    assert.equal((await save(100_000_000, 43_200)).ok, true);
    assert.equal(requests, 0);
    const restored = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error(); } }); await restored.restore();
    assert.deepEqual(restored.data.settings, { maxTokens: 100_000_000, maxMinutes: 43_200, publishMode: 'review', executionMode: 'manual' });
    assert.equal((await save(0, 0)).ok, true);
    for (const [tokens, minutes, field] of [[-1, 30, 'Token'], [1.5, 30, 'Token'], [Number.MAX_SAFE_INTEGER + 1, 30, 'Token'], [1000, -1, '运行时间'], [1000, '120', '运行时间']] as const) {
      const result = await save(tokens, minutes); assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.error.message.includes(field), result.error.message);
      assert.deepEqual(client.data.settings, { maxTokens: 0, maxMinutes: 0, publishMode: 'review', executionMode: 'manual' });
    }
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

test('an agent becoming idle after inspection is re-read before an unfinished snapshot is called interrupted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-settlement-'));
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('No network expected'); } }); await client.restore();
  const runId = randomUUID(), sessionId = 'session-' + randomUUID(); let reads = 0;
  client.data.runs[runId] = { id: runId, sessionId, taskId: randomUUID(), taskRevision: 1, title: 'fixture', mode: 'reply', status: 'running', startedAt: Date.now(), limits: { ...client.data.settings } };
  const ctx: any = { agents: { get: () => ({ status: 'idle' }) }, sessionController: { inspect: async () => ({ meta: { id: sessionId }, inheritedEventCount: 0,
    events: [{ type: 'turn/start', data: { turn: 1 } }, ...(++reads > 1 ? [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }] : [])] }) }, sessionPersistence: { flush: async () => {}, list: async () => [] } };
  const host = new CollabHost(client, ctx, () => undefined, { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' });
  try {
    const result = await host.handle('run', { args: { runId } }, new AbortController().signal); assert.equal(result.ok, true);
    assert.equal(client.data.runs[runId].status, 'completed'); assert.equal(client.data.runs[runId].stopReason, undefined);
    assert.equal(reads, 2);
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});

test('candidate pages, subject navigation and precise read receipts are proxied without model work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-collab-proxy-'));
  const client = new CollabClient(home, { isRegistered: () => true, grant: async () => { throw new Error('Fixture only'); } }); await client.restore();
  const calls: { path: string; body: unknown }[] = [];
  client.api = async (path, body) => { calls.push({ path, body }); return { items: [], hasMore: false, total: 0 }; };
  const host = new CollabHost(client, {} as any, () => undefined, { appVersion: 'test', runtimeVersion: 'test', pluginVersion: 'test', platform: 'test', arch: 'test' });
  const taskId = randomUUID(), subjectId = randomUUID();
  const rpc = (method: string, args: object) => host.handle(method, { args }, new AbortController().signal);
  try {
    assert.equal((await rpc('catalog', { view: 'participating', explorationStatus: 'active' })).ok, true);
    assert.match(calls.at(-1)!.path, /explorationStatus=active/);
    assert.equal((await rpc('candidates', { taskId, offset: 50 })).ok, true);
    assert.equal(calls.at(-1)!.path, `tasks/${taskId}/candidates?offset=50`);
    assert.equal((await rpc('detail', { taskId, subjectId })).ok, true);
    assert.equal(calls.at(-1)!.path, `tasks/${taskId}?offset=0&subjectId=${subjectId}`);
    assert.equal((await rpc('read', { eventIds: [4, 7, 4], taskId })).ok, true);
    assert.deepEqual(calls.at(-1)!.body, { eventIds: [4, 7], taskId });
    const count = calls.length;
    assert.equal((await rpc('read', { eventIds: [0] })).ok, false);
    assert.equal((await rpc('read', { eventIds: Array(201).fill(1) })).ok, false);
    assert.equal(calls.length, count);
  } finally { await client.stop(); await rm(home, { recursive: true, force: true }); }
});
