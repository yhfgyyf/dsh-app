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
const prompt = (text: string) => client.rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } });
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
    await prompt(`[desktop-${mode}] 执行隔离的桌面能力验收。`);
    await session.wait(frames => frames.slice(before).some(frame => frame.type === 'event' && frame.event.type === 'turn/end'), 25000);
    const frames = session.frames.slice(before);
    await writeFile(new URL(`../.test-data/${mode}-events.json`, import.meta.url), JSON.stringify(frames, null, 2));
    const data = JSON.stringify(frames);
    assert.ok(data.includes('Hello, DSH Desktop'), 'parent must finish with the fixture reply');
    const result = frames.filter(frame => frame.event?.type === 'tool/result').flatMap(frame => frame.event.data.message.content).at(-1);
    assert.equal(result?.isError, false, JSON.stringify(result));
    const output = result.content.map((block: any) => block.text ?? '').join('');
    if (mode === 'workflow') { const run = JSON.parse(output); assert.equal(run.agentsStarted, 1); assert.equal(run.result.verified, true); assert.ok(run.result.result.includes('Hello, DSH Desktop')); }
    if (mode === 'subagent') { const run = JSON.parse(output); assert.equal(run.kind, 'foreground'); assert.ok(run.runId); assert.ok(JSON.stringify(run.output).includes('Hello, DSH Desktop')); }
    if (mode === 'jobs') assert.ok(/jobId|job_id/.test(output), output);
  });
  await check('dynamic Cordis defines a host package and runs, stops and removes the disposable plugin', async () => {
    const created = await client.rpc('session/create', { request: { cwd: new URL('../.test-data/workspace', import.meta.url).pathname, agentPreset: 'cordis' } });
    const agentId = created.sessionId;
    const stream = client.follow('session/follow', { request: { address: { kind: 'session', sessionId: agentId } } });
    try {
      await stream.wait(frames => frames.some(frame => frame.type === 'snapshot'));
      await client.rpc('session/prompt', { request: { sessionId: agentId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '[desktop-cordis] 验证无副作用的动态插件生命周期。' }] } });
      await stream.wait(frames => frames.some(frame => frame.event?.type === 'turn/end'), 20000);
      const inventory = await client.rpc('dynamicCordisRunner/inventory');
      const plugin = inventory.find((row: any) => row.agentId === agentId && row.packages.some((pkg: any) => pkg.name === 'Desktop lifecycle fixture'));
      assert.ok(plugin, 'defined Cordis package must appear in real inventory');
      const params = { agentId, pluginId: plugin.pluginId };
      const started = await client.rpc('dynamicCordisRunner/runHostHalf', { ...params, packageId: plugin.packages[0].packageId, mode: 'run', requestId: null, approveFutureVersions: false });
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal((await client.rpc('dynamicCordisRunner/stopFromPanel', params)).ok, true);
      assert.equal((await client.rpc('dynamicCordisRunner/undefineFromPanel', params)).ok, true);
      assert.equal((await client.rpc('dynamicCordisRunner/inventory')).some((row: any) => row.pluginId === plugin.pluginId), false);
    } finally { stream.close(); }
  });

} finally {
  session.close(); events.close(); client.close();
  await writeFile(new URL('../docs/evidence/tools.json', import.meta.url), JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
}
if (results.some(row => row.status === 'fail')) process.exitCode = 1;
