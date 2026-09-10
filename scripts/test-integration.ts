import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { connectFixture } from '../tests/fixture-client.ts';
import { withDesktopPlugin } from '../src/shared/dsh-boot.ts';
import { pngFixture } from '../tests/png-fixture.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const client = await connectFixture();
const { rpc, follow } = client;
const results: { name: string; status: string; details?: unknown }[] = [];
async function check(name: string, fn: () => Promise<unknown>) {
  try { const details = await fn(); results.push({ name, status: 'pass', ...(details === undefined ? {} : { details }) }); console.log('PASS', name); }
  catch (error) { results.push({ name, status: 'fail', details: error instanceof Error ? error.message : String(error) }); console.log('FAIL', name, error instanceof Error ? error.message : String(error)); }
}
let sessionId: string;
let workspaceId: string;
let control: ReturnType<typeof follow>;
let session: ReturnType<typeof follow>;
let catalog: any;
try {
  await check('owned core has no Web homepage and loads the complete plugin roster', async () => {
    const response = await fetch(client.endpoint, { headers: client.headers });
    assert.equal(response.status, 204);
    const ready = JSON.parse(await readFile(join(root, '.test-data/fixture-connection.json'), 'utf8'));
    assert.ok(ready.hostPlugins.every((name: string) => !name.includes('dsh-web-app')));
    const graph = ready.graph;
    const extended = withDesktopPlugin(graph, '0.1.0');
    assert.equal(extended.entries.length, graph.entries.length + 1);
    assert.deepEqual(extended.entries.slice(0, -1), graph.entries);
    assert.ok(graph.entries.some((entry: any) => entry.id === 'dsh-audit-mode'));
    assert.equal(graph.entries.some((entry: any) => entry.id.includes('ui-schedule')), false);
    const bytes: { entries: string[]; sha256: string; bytes: number }[] = [];
    for (const batch of graph.batches) {
      const response = await fetch(client.endpoint + batch.url, { headers: client.headers });
      assert.equal(response.status, 200);
      const data = Buffer.from(await response.arrayBuffer());
      bytes.push({ entries: batch.entries, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length });
    }
    await writeFile(join(root, '.test-data/fixture-graph.json'), JSON.stringify(graph, null, 2));
    return { modules: graph.entries.length, batches: bytes };
  });
  await check('workspace adoption and rename with the deployed native directory picker', async () => {
    const path = join(root, '.test-data/workspace');
    const listing = await rpc('directoryPicker/list', { path }, true);
    assert.equal(listing.error?.code, 'directory-picker/unavailable');
    assert.equal(listing.error?.details.capability, 'native');
    const created = await rpc('workspace/create', { request: { path } });
    workspaceId = created.workspace.workspaceId;
    const renamed = await rpc('workspace/rename', { request: { workspaceId, title: '桌面测试工作区' } });
    assert.equal(renamed.workspace.title, '桌面测试工作区');
  });
  await check('workspace and session control WebSocket baselines', async () => {
    const workspace = follow('workspace/follow');
    await workspace.wait(frames => frames.some(frame => frame.type === 'baseline'));
    assert.ok(workspace.frames[0].value.items.some((item: any) => item.workspaceId === workspaceId));
    workspace.close();
    control = follow('session/control');
    await control.wait(frames => frames.some(frame => frame.type === 'baseline'));
  });
  await check('preset roster includes native modes and local auto router', async () => {
    const roster = await rpc('agentPresets/list');
    await writeFile(join(root, '.test-data/presets.json'), JSON.stringify(roster, null, 2));
    for (const id of ['standard', 'ptc', 'minimal', 'cordis', 'auto', 'audit']) assert.ok(roster.presets.some((preset: any) => preset.id === id), `missing ${id}`);
    return roster;
  });
  await check('session creation, selection, rename, list and initial history', async () => {
    const created = await rpc('session/create', { request: { workspaceId, agentPreset: 'standard' } });
    sessionId = created.sessionId;
    await writeFile(join(root, '.test-data/test-session.json'), JSON.stringify({ sessionId, workspaceId }));
    const title = '桌面全功能测试 ' + new Date().toISOString().slice(0, 16);
    assert.equal((await rpc('session/rename', { request: { sessionId, title } })).title, title);
    assert.ok((await rpc('session/list', { _request: {} })).items.some((item: any) => item.sessionId === sessionId));
    session = follow('session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true } });
    await session.wait(frames => frames.some(frame => frame.type === 'snapshot'));
    assert.equal(session.frames[0].header.id, sessionId);
  });
  await check('model catalog, reasoning selection and durable session state', async () => {
    catalog = await rpc('session/modelCatalog');
    const selected = await rpc('session/selectModel', { request: { sessionId, ...catalog.default, reasoningEffort: 'high' } });
    assert.equal(selected.selected.reasoningEffort, 'high');
    await control.wait(frames => frames.some(frame => frame.type === 'projection' && frame.sessionId === sessionId && frame.key === 'modelSelection'));
    return catalog;
  });
  await check('command, skill and file reference catalogs', async () => {
    const commands = await rpc('commands/list', { agentId: sessionId });
    assert.ok(commands.length > 0);
    const skills = await rpc('skills/list', { request: { sessionId } });
    assert.ok(Array.isArray(skills.skills));
    const files = await rpc('fileReferences/list', { agentId: sessionId, query: 'example' });
    assert.ok(files.some((file: any) => file.path.includes('example.ts')));
    return { commands: commands.map((command: any) => command.name), skills: skills.skills.length, files };
  });
  await check('submit Chinese message, reasoning/content streaming, usage and turn completion', async () => {
    const accepted = await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '你好，请测试桌面消息、Markdown 和代码块。' }], clientTimeZone: 'Asia/Taipei' } });
    assert.equal(accepted.accepted, true);
    await session.wait(frames => frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end'), 25000);
    const events = session.frames.filter(frame => frame.type === 'event').map(frame => frame.event);
    await writeFile(join(root, '.test-data/session-events.json'), JSON.stringify(events, null, 2));
    assert.ok(JSON.stringify(events).includes('DSH Desktop'));
    assert.ok(events.some(event => event.type === 'assistant/message'));
    assert.ok(session.frames.some(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk'));
    return { eventTypes: [...new Set(events.map(event => event.type))], events: events.length };
  });
  await check('reopen history preserves conversation and model selection', async () => {
    const reopened = follow('session/follow', { request: { address: { kind: 'session', sessionId } } });
    await reopened.wait(frames => frames.length > 0);
    const snapshot = reopened.frames[0];
    assert.equal(snapshot.type, 'snapshot');
    assert.ok(JSON.stringify(snapshot.records).includes('桌面消息'));
    assert.ok(snapshot.projections.values.modelSelection);
    const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: snapshot.cursor, maxMessages: 2 } });
    assert.ok(page.records.length > 0);
    reopened.close();
  });
  await check('branching preserves the source conversation and creates an independent session', async () => {
    const fork = await rpc('session/fork', { request: { sessionId } });
    assert.notEqual(fork.sessionId, sessionId);
    const branch = follow('session/follow', { request: { address: { kind: 'session', sessionId: fork.sessionId } } });
    await branch.wait(frames => frames.length > 0);
    assert.ok(JSON.stringify(branch.frames).includes('桌面消息'));
    branch.close();
    const deleted = await rpc('session/delete', { request: { sessionId: fork.sessionId } });
    assert.equal(deleted.sessionId, fork.sessionId);
    assert.equal((await rpc('session/list', { _request: {} })).items.some((item: any) => item.sessionId === fork.sessionId), false);
  });
  await check('slow reply cancellation keeps the session available', async () => {
    const before = session.frames.length;
    await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '慢速回复，验证取消功能。' }] } });
    await session.wait(frames => frames.slice(before).some(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk'));
    assert.equal((await rpc('session/cancel', { request: { sessionId } })).accepted, true);
    await session.wait(frames => frames.slice(before).some(frame => frame.type === 'event' && frame.event.type === 'turn/end'));
    assert.ok((await rpc('session/list', { _request: {} })).items.some((item: any) => item.sessionId === sessionId));
  });
  await check('settings inventory includes original plugin configuration', async () => {
    const settings = await rpc('settings/describe');
    await writeFile(join(root, '.test-data/settings-description.json'), JSON.stringify(settings, null, 2));
    assert.ok(JSON.stringify(settings).includes('llm-deepseek'));
    for (const ns of ['ui-theme', 'locale', 'ui-conversation', 'ui-chat', 'permission', 'agent-presets', 'agent-loop']) assert.ok(settings.namespaces.some((entry: any) => entry.ns === ns));
    return { namespaces: settings.namespaces.map((entry: any) => entry.ns) };
  });
  await check('theme, font size and composer settings persist with revision checks', async () => {
    const settings = await rpc('settings/describe');
    const original = settings.namespaces.find((entry: any) => entry.ns === 'ui-theme');
    const changed = await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'dark', fontSize: 16 }, expectedRevision: original.revision });
    assert.equal(changed.value.preference, 'dark');
    assert.equal(changed.value.fontSize, 16);
    const fresh = (await rpc('settings/describe')).namespaces.find((entry: any) => entry.ns === 'ui-theme');
    assert.equal(fresh.value.fontSize, 16);
    await rpc('settings/update', { ns: 'ui-theme', patch: original.value, expectedRevision: fresh.revision });
    const composer = settings.namespaces.find((entry: any) => entry.ns === 'ui-conversation');
    const edited = await rpc('settings/update', { ns: 'ui-conversation', patch: { busyEnter: 'steer' }, expectedRevision: composer.revision });
    assert.equal(edited.value.busyEnter, 'steer');
    await rpc('settings/update', { ns: 'ui-conversation', patch: composer.value, expectedRevision: edited.revision });
  });
  await check('preset copying, composition reading and deletion affect only a disposable preset', async () => {
    const id = 'desktop-test-' + randomUUID().slice(0, 8);
    await rpc('agentPresets/copy', { from: 'standard', id, name: '桌面测试预设' });
    const document = await rpc('agentPresets/read', { agentPreset: id });
    assert.ok(JSON.stringify(document).includes(id));
    await rpc('agentPresets/deletePreset', { id });
    assert.equal((await rpc('agentPresets/list')).presets.some((entry: any) => entry.id === id), false);
  });
  await check('message feedback create, negative update, reload and removal', async () => {
    const event = session.frames.find(frame => frame.type === 'event' && frame.event.type === 'assistant/message');
    const messageId = event.event.data.message.id;
    const positive = await rpc('messageFeedback/put', { request: { sessionId, messageId, rating: 'positive', ifVersion: null } });
    assert.equal(positive.ok, true);
    const negative = await rpc('messageFeedback/put', { request: { sessionId, messageId, rating: 'negative', note: '桌面测试反馈', ifVersion: positive.value.version } });
    assert.equal(negative.value.rating, 'negative');
    const list = await rpc('messageFeedback/list', { request: { sessionId } });
    assert.equal(list.value.items[0].note, '桌面测试反馈');
    await rpc('messageFeedback/delete', { request: { sessionId, messageId, ifVersion: negative.value.version } });
    assert.equal((await rpc('messageFeedback/list', { request: { sessionId } })).value.items.length, 0);
  });
  await check('session ZIP export supports HEAD and returns a downloadable archive', async () => {
    const url = client.endpoint + '/api/session.export?sessionId=' + encodeURIComponent(sessionId) + '&includeDescendants=true';
    assert.equal((await fetch(url, { method: 'HEAD', headers: client.headers })).status, 200);
    const response = await fetch(url, { headers: client.headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') ?? '', /attachment/);
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    await writeFile(join(root, '.test-data/export.zip'), zip);
    return { bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') };
  });
  await check('queued message editing/removal and cancellation are reflected in live control frames', async () => {
    const before = session.frames.length;
    await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '慢速回复，验证队列操作。' }] } });
    await session.wait(frames => frames.slice(before).some(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk'));
    const requestId = randomUUID();
    const controlBefore = control.frames.length;
    await rpc('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: '待编辑队列消息' }] } });
    await control.wait(frames => frames.slice(controlBefore).some(frame => frame.type === 'queue' && frame.items.some((item: any) => item.rpcId === requestId)));
    const queueFrame = control.frames.slice(controlBefore).find(frame => frame.type === 'queue' && frame.items.some((item: any) => item.rpcId === requestId));
    const itemId = queueFrame.items.find((item: any) => item.rpcId === requestId).id;
    await rpc('session/updateQueue', { request: { sessionId, itemId, action: { kind: 'edit', content: [{ type: 'text', text: '已编辑队列消息' }] } } });
    await control.wait(frames => frames.slice(controlBefore).some(frame => frame.type === 'queue' && JSON.stringify(frame.items).includes('已编辑队列消息')));
    await rpc('session/updateQueue', { request: { sessionId, itemId, action: { kind: 'remove' } } });
    await rpc('session/cancel', { request: { sessionId } });
    await session.wait(frames => frames.slice(before).some(frame => frame.type === 'event' && frame.event.type === 'turn/end'));
  });
  await check('image attachment intake, durable reference and byte-identical readback', async () => {
    const before = session.frames.length;
    const png = pngFixture().toString('base64');
    await writeFile(join(root, '.test-data/desktop-fixture.png'), pngFixture());
    const model = catalog.groups.flatMap((group: any) => group.models).find((model: any) => model.id.includes('vision'));
    assert.ok(model);
    await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: model.id, reasoningEffort: 'high' } });
    await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '附件测试图片。' }, { type: 'image', mediaType: 'image/png', data: png, name: 'desktop-fixture.png' }] } });
    await session.wait(frames => frames.slice(before).some(frame => frame.type === 'event' && frame.event.type === 'turn/end'));
    const frames = JSON.stringify(session.frames.slice(before));
    const id = frames.match(/"attachmentId":"([^"]+)"/)?.[1];
    assert.ok(id);
    const attachment = await rpc('session/attachment', { request: { sessionId, attachmentId: id } });
    assert.equal(attachment.data, png);
    assert.equal(attachment.attachment.mediaType, 'image/png');
  });
  await check('plan and permission commands update durable session projections', async () => {
    const initial = control.frames.length;
    const plan = await rpc('commands/execute', { agentId: sessionId, line: '/plan', submittedAttachments: [] });
    assert.equal(plan.result.kind, 'success');
    await control.wait(frames => frames.slice(initial).some(frame => frame.type === 'projection' && frame.sessionId === sessionId && frame.key === 'plan'));
    assert.equal((await rpc('commands/execute', { agentId: sessionId, line: '/plan off', submittedAttachments: [] })).result.kind, 'success');
    assert.equal((await rpc('commands/execute', { agentId: sessionId, line: '/permission read-only', submittedAttachments: [] })).result.kind, 'success');
    assert.equal((await rpc('commands/execute', { agentId: sessionId, line: '/permission workspace-write', submittedAttachments: [] })).result.kind, 'success');
  });
  await check('goal create, pause, edit, resume, complete and clear lifecycle', async () => {
    const created = await rpc('goals/create', { agentId: sessionId, request: { objective: '验证测试目标状态', maxGoalRounds: 1 } });
    let goal = await rpc('goals/pause', { agentId: sessionId, ref: created.ref });
    assert.equal(goal.phase, 'paused');
    goal = await rpc('goals/edit', { agentId: sessionId, ref: { id: goal.id, revision: goal.revision }, request: { objective: '已编辑的测试目标' } });
    assert.equal(goal.objective, '已编辑的测试目标');
    goal = await rpc('goals/resume', { agentId: sessionId, ref: { id: goal.id, revision: goal.revision } });
    assert.equal(goal.phase, 'active');
    goal = await rpc('goals/complete', { agentId: sessionId, ref: { id: goal.id, revision: goal.revision } });
    assert.equal(goal.phase, 'complete');
    const cleared = await rpc('goals/clear', { agentId: sessionId, ref: { id: goal.id, revision: goal.revision } });
    assert.equal(cleared.id, goal.id);
  });
} finally {
  client.close();
  await mkdir(join(root, 'docs/evidence'), { recursive: true });
  const version = JSON.parse(await readFile(join(root, 'runtime/dependencies.json'), 'utf8')).dsh;
  await writeFile(join(root, 'docs/evidence/integration.json'), JSON.stringify({ timestamp: new Date().toISOString(), environment: `isolated DSH ${version} + deterministic local provider`, results }, null, 2));
  console.log(`${results.filter(result => result.status === 'pass').length}/${results.length} integration workflows passed.`);
  if (results.some(result => result.status === 'fail')) process.exitCode = 1;
}
