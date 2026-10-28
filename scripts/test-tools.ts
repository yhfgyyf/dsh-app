import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, access } from 'node:fs/promises';
import { connectFixture } from '../tests/fixture-client.ts';
const client = await connectFixture();
const results: { name: string; status: string; details?: string }[] = [];
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ name, status: 'pass' }); console.log('PASS', name); }
  catch (error) { const details = error instanceof Error ? error.message : String(error); results.push({ name, status: 'fail', details }); console.log('FAIL', name, details); }
};
const events = client.follow('$events');
await events.wait(frames => frames.some(frame => frame.type === 'ready'));
const clientId = events.frames.find(frame => frame.type === 'ready').clientId;
const created = await client.rpc('session/create', { request: { cwd: new URL('../.test-data/workspace', import.meta.url).pathname, agentPreset: 'standard' } });
const sessionId = created.sessionId;
const session = client.follow('session/follow', { request: { address: { kind: 'session', sessionId } } });
await session.wait(frames => frames.some(frame => frame.type === 'snapshot'));
const prompt = async (text: string) => {
  const requestId = randomUUID();
  await client.rpc('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] } });
  return requestId;
};
const promptEnded = (frames: any[], requestId: string) => {
  let turn, ownTurn;
  for (const frame of frames) {
    const event = frame.event;
    if (event?.type === 'turn/start') turn = event.data.turn;
    if (event?.type === 'user/message' && event.data.source?.rpcId === requestId) ownTurn = turn;
    if (event?.type === 'turn/end' && ownTurn !== undefined && event.data.turn === ownTurn) return true;
  }
  return false;
};
try {
  await check('progressive tool discovery, schema loading and actual file read', async () => {
    const start = session.frames.length;
    await prompt('[desktop-tools] 请执行隔离的文件读取验收。');
    await session.wait(frames => frames.slice(start).some(frame => frame.type === 'event' && frame.event.type === 'turn/end'), 20000);
    const frames = session.frames.slice(start);
    await writeFile(new URL('../.test-data/tool-events.json', import.meta.url), JSON.stringify(frames, null, 2));
    assert.ok(JSON.stringify(frames).includes('Desktop test workspace'), 'file read result must contain actual test file content');
    assert.ok(JSON.stringify(frames).includes('Hello, DSH Desktop'), 'tool turn must reach the final model reply');
  });
  await check('PTC discovers schemas and executes the real file tool through run_code', async () => {
    const created = await client.rpc('session/create', { request: { cwd: new URL('../.test-data/workspace', import.meta.url).pathname, agentPreset: 'ptc' } });
    const stream = client.follow('session/follow', { request: { address: { kind: 'session', sessionId: created.sessionId } } });
    try {
      await stream.wait(rows => rows.some(row => row.type === 'snapshot'));
      await client.rpc('session/prompt', { request: { sessionId: created.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '[desktop-tools] Verify PTC with the isolated workspace.' }] } });
      await stream.wait(rows => rows.some(row => row.event?.type === 'turn/end'), 25000);
      await writeFile(new URL('../.test-data/ptc-tools-events.json', import.meta.url), JSON.stringify(stream.frames, null, 2));
      const text = JSON.stringify(stream.frames);
      assert.match(text, /Desktop test workspace/);
      assert.match(text, /Hello, DSH Desktop/);
      assert.ok(stream.frames.some(row => row.event?.type === 'tool/call' && JSON.stringify(row.event.data).includes('run_code')));
      assert.ok(stream.frames.filter(row => row.event?.type === 'turn/end').every(row => row.event.data.reason.kind === 'completed'));
    } finally { stream.close(); }
  });
  await check('user question round trip through the scoped Remote Event waterfall', async () => {
    const start = session.frames.length;
    const eventStart = events.frames.length;
    await prompt('[desktop-question] 请触发桌面选择题验收。');
    await events.wait(frames => frames.slice(eventStart).some(frame => frame.type === 'waterfall' && frame.event === 'user-questions/request'), 20000);
    const event = events.frames.slice(eventStart).find(frame => frame.type === 'waterfall' && frame.event === 'user-questions/request');
    assert.equal(event.agentId, sessionId);
    assert.equal(event.request.questions[0].id, 'desktop-choice');
    await client.rpc('$events/result', { clientId, eventId: event.eventId, outcome: { kind: 'result', value: { answers: [{ id: 'desktop-choice', selected: ['通过'] }] } } });
    await session.wait(frames => frames.slice(start).some(frame => frame.type === 'event' && frame.event.type === 'turn/end'), 20000);
    const data = JSON.stringify(session.frames.slice(start));
    assert.match(data, /通过/); assert.match(data, /Hello, DSH Desktop/);
  });
  await check('one-time file approval rejects safely, then permits only the requested test write', async () => {
    for (const decision of ['rejected', 'allowed-once']) {
      const id = randomUUID();
      const path = new URL(`../.test-data/approval-${id}.txt`, import.meta.url);
      const start = session.frames.length;
      const eventStart = events.frames.length;
      await prompt(`[desktop-approval:${id}] 验证隔离测试文件的单次审批。`);
      await events.wait(frames => frames.slice(eventStart).some(frame => frame.type === 'waterfall' && frame.event === 'approval/request'), 20000);
      const event = events.frames.slice(eventStart).find(frame => frame.type === 'waterfall' && frame.event === 'approval/request');
      assert.equal(event.agentId, sessionId);
      await client.rpc('$events/result', { clientId, eventId: event.eventId, outcome: { kind: 'result', value: decision } });
      await session.wait(frames => frames.slice(start).some(frame => frame.type === 'event' && frame.event.type === 'turn/end'), 20000);
      if (decision === 'rejected') await assert.rejects(access(path));
      else assert.equal(await readFile(path, 'utf8'), 'Desktop one-time approval verified.\n');
      assert.ok(session.frames.slice(start).some(frame => frame.type === 'event' && frame.event.type === 'approval/decided' && frame.event.data.outcome === decision));
    }
  });
  for (const mode of ['workflow', 'subagent', 'jobs']) await check(`${mode} executes in the owned core and retains its result`, async () => {
    const before = session.frames.length;
    const requestId = await prompt(`[desktop-${mode}] 执行隔离的桌面能力验收。`);
    await session.wait(frames => promptEnded(frames.slice(before), requestId), 25000);
    const frames = session.frames.slice(before);
    await writeFile(new URL(`../.test-data/${mode}-events.json`, import.meta.url), JSON.stringify(frames, null, 2));
    const data = JSON.stringify(frames);
    assert.ok(data.includes('Hello, DSH Desktop'), 'parent must finish with the fixture reply');
    const result = frames.filter(frame => frame.event?.type === 'tool/result').map(frame => frame.event.data.message).at(-1);
    assert.equal(result?.isError, false, JSON.stringify(result));
    const output = result.content.map((block: any) => block.text ?? '').join('');
    if (mode === 'workflow') { assert.match(output, /completed \(1 agent\)/); assert.match(output, /"verified": true/); assert.ok(output.includes('Hello, DSH Desktop')); }
    if (mode === 'subagent') {
      const childSessionId = output.match(/started subagent (\S+)/)?.[1];
      assert.ok(childSessionId, 'The new asynchronous subagent API returns its child identity');
      const child = client.follow('session/follow', { request: { address: { kind: 'subagent', parentSessionId: sessionId, childSessionId, mode: 'continuable' } } });
      try {
        await child.wait(rows => JSON.stringify(rows).includes('Hello, DSH Desktop'), 20000);
      } finally { child.close(); }
    }
    if (mode === 'jobs') assert.match(output, /started background job \S+/);
  });
  await check('Creator lists the live Host API and current tool schemas without changing plugins', async () => {
    const created = await client.rpc('session/create', { request: { cwd: new URL('../.test-data/workspace', import.meta.url).pathname, agentPreset: 'cordis' } });
    const agentId = created.sessionId;
    const stream = client.follow('session/follow', { request: { address: { kind: 'session', sessionId: agentId } } });
    try {
      await stream.wait(frames => frames.some(frame => frame.type === 'snapshot'));
      await client.rpc('session/prompt', { request: { sessionId: agentId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '[desktop-cordis] 验证只读 Host API 与当前工具目录。' }] } });
      await stream.wait(frames => frames.some(frame => frame.event?.type === 'turn/end'), 20000);
      await writeFile(new URL('../.test-data/cordis-events.json', import.meta.url), JSON.stringify(stream.frames, null, 2));
      const results = stream.frames.filter(frame => frame.event?.type === 'tool/result').map(frame => frame.event.data.message);
      const result = results.at(-1);
      assert.equal(result?.isError, false, JSON.stringify(result));
      let output = result.content.map((block: any) => block.text ?? '').join('');
      // The expanded 0.2.2 catalog can exceed the normal inline result budget.
      // Validate the retained full result rather than parsing its shortened preview.
      const spill = output.match(/Full formatted result stored at: (.+)\. Use read with offset\/limit/);
      if (spill) output = await readFile(spill[1], 'utf8');
      const inspection = JSON.parse(output);
      assert.equal(inspection.platform, 'host');
      assert.equal(inspection.provider, 'Tool');
      assert.equal(inspection.method, 'listTools');
      const tools = inspection.data.tools.map((tool: any) => tool.name);
      for (const name of ['cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager']) assert.ok(tools.includes(name), name);
      for (const name of ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine']) assert.equal(tools.includes(name), false, name);
      assert.ok(JSON.stringify(stream.frames).includes('Hello, DSH Desktop'));
      await writeFile(new URL('../.test-data/cordis-events.json', import.meta.url), JSON.stringify(stream.frames, null, 2));
    } finally { stream.close(); }
  });

} finally {
  session.close(); events.close(); client.close();
  await writeFile(new URL('../docs/evidence/tools.json', import.meta.url), JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
}
if (results.some(row => row.status === 'fail')) process.exitCode = 1;
