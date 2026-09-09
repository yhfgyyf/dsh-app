import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { DesktopComputerUse } from '../src/main/computer-use.ts';
import type { ComputerDriver } from '../src/main/computer-use-driver.ts';
import { connectFixture } from '../tests/fixture-client.ts';
import { pngFixture } from '../tests/png-fixture.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.test-data'), { recursive: true });
const data = await mkdtemp(join(root, '.test-data/computer-tools-'));
const home = join(data, 'core'); await mkdir(home);
let driverCalls = 0;
const driver: ComputerDriver = {
  permissions: async () => ({ supported: true, accessibility: true, screenRecording: true }),
  start: async () => {}, stop: async () => {}, describe: async () => ({ tools: [] }),
  call: async (name) => {
    ++driverCalls;
    return { text: 'fixture computer evidence', data: { snapshot_id: 's12345678', elements: [{ element_index: 1, element_token: 's12345678:1', label: 'Fixture button' }], effect: 'confirmed', tool: name }, images: name === 'get_window_state' ? [{ mimeType: 'image/png', dataBase64: pngFixture().toString('base64') }] : [] };
  },
};
const broker = new DesktopComputerUse(driver);
const names = ['computer_status', 'computer_start', 'computer_observe', 'computer_act', 'computer_stop'];
const report: { checks: string[]; failures: string[] } = { checks: [], failures: [] };
let current: { face: string; decision: string; step: number; observation?: string; imageSeen: boolean };
const uploaded = new Map<string, Record<string, unknown>>();
const mock = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = bytes.toString('utf8');
    if (req.url?.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] })); return; }
    if (req.url === '/files' && req.method === 'POST') {
      const form = await new Request('http://127.0.0.1/files', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: bytes }).formData();
      const file = form.get('file') as File;
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), pngFixture(), 'Provider upload must carry the exact fixture screenshot');
      const id = 'file-fixture-' + randomUUID();
      const value = { id, object: 'file', bytes: file.size, created_at: Math.floor(Date.now() / 1000), filename: file.name, purpose: 'user_data', expires_at: Math.floor(Date.now() / 1000) + 86400 };
      uploaded.set(id, value); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return;
    }
    if (req.url?.startsWith('/files/')) {
      const id = req.url.slice('/files/'.length), value = uploaded.get(id); assert.ok(value);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.method === 'DELETE' ? { id, object: 'file', deleted: true } : value)); return;
    }
    const request = JSON.parse(body);
    if (!req.url?.endsWith('/chat/completions') || !current) throw new Error('Unexpected model request.');
    await writeFile(join(data, `${current.face}-${current.decision}-request-${current.step}.json`), JSON.stringify(request, null, 2));
    const hasImage = request.messages?.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === 'image_url' && /^data:image\//.test(block.image_url?.url) || block.type === 'file' && uploaded.has(block.file_id)));
    current.imageSeen ||= hasImage;
    const calls = [
      { name: 'search_tools', arguments: { query: 'computer' } },
      { name: 'describe_tools', arguments: { names } },
      { name: 'computer_start', arguments: { reason: 'Only the disposable computer tool fixture', application_pid: 123 } },
      ...(current.decision === 'allowed-once' ? [
        { name: 'computer_observe', arguments: { kind: 'window', pid: 123, window_id: 456 } },
        { name: 'computer_act', arguments: { action: 'click', observation_id: current.observation, arguments: { element_index: 1 } } },
        { name: 'computer_stop', arguments: {} },
      ] : []),
    ];
    let call = calls[current.step++];
    if (call && current.face === 'invoke' && call.name.startsWith('computer_')) call = { name: 'invoke_tool', arguments: { name: call.name, arguments: call.arguments } } as any;
    if (call && current.face === 'ptc') call = { name: 'run_code', arguments: { code: `const result = await tools.${call.name}(${JSON.stringify(call.arguments)}); return result;`, description: 'Isolated computer transport test' } } as any;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'computer-fixture', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.write(frame({ role: 'assistant', reasoning_content: 'Run the isolated computer fixture.' }));
    if (call) { res.write(frame({ tool_calls: [{ index: 0, id: 'computer_' + current.step, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] })); res.write(frame({}, 'tool_calls')); }
    else res.write(frame({ content: 'COMPUTER_FIXTURE_DONE' }, 'stop'));
    res.end('data: [DONE]\n\n');
  } catch (error) { report.failures.push(String(error)); res.writeHead(500); res.end('fixture failed'); }
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
await writeFile(join(home, 'desktop.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${(mock.address() as { port: number }).port}\n    apiKeyEnv: DSH_DESKTOP_COMPUTER_FIXTURE_KEY\n    maxTokens: 4096\n`);
process.env.DSH_DESKTOP_COMPUTER_FIXTURE_KEY = 'disposable-local-fixture';
const core = new DesktopRuntime({ runtimeRoot: join(root, '.runtime'), entry: join(root, '.runtime/app/index.ts'), home, cwd: data, onExit: () => {}, computerRequest: async (request, signal) => {
  const result = await broker.request(request, signal);
  if (request.operation === 'observe') current.observation = (result.data as any)?.observation_id;
  return result;
}, computerStop: () => broker.stop() });
let client: Awaited<ReturnType<typeof connectFixture>> | undefined;
try {
  const ready = await core.start();
  const connection = join(data, 'connection.json'); await writeFile(connection, JSON.stringify({ owner: 'dsh-desktop-test', ...ready }), { mode: 0o600 });
  client = await connectFixture(connection);
  const events = client.follow('$events'); await events.wait(frames => frames.some(frame => frame.type === 'ready'));
  const clientId = events.frames.find(frame => frame.type === 'ready').clientId;
  for (const face of ['native', 'invoke', 'ptc']) for (const decision of ['rejected', 'allowed-once']) {
    current = { face, decision, step: 0, imageSeen: false };
    const created = await client.rpc('session/create', { request: { cwd: data, agentPreset: face === 'ptc' ? 'ptc' : 'standard' } });
    const sessionId = created.sessionId;
    await client.rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'high' } });
    const stream = client.follow('session/follow', { request: { address: { kind: 'session', sessionId } } });
    await stream.wait(frames => frames.some(frame => frame.type === 'snapshot'));
    const beforeCalls = driverCalls;
    const eventStart = events.frames.length;
    const handled = new Set<string>();
    let approvalCount = 0;
    const approvals = setInterval(() => {
      for (const event of events.frames.slice(eventStart)) {
        if (event.type !== 'waterfall' || event.event !== 'approval/request' || event.agentId !== sessionId || handled.has(event.eventId)) continue;
        handled.add(event.eventId); ++approvalCount;
        void client!.rpc('$events/result', { clientId, eventId: event.eventId, outcome: { kind: 'result', value: decision } }).catch(error => report.failures.push(String(error)));
      }
    }, 50);
    try {
      await client.rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Run the isolated desktop computer fixture.' }] } });
      await stream.wait(frames => frames.some(frame => frame.event?.type === 'turn/end'), 35000);
      await writeFile(join(data, `${face}-${decision}-events.json`), JSON.stringify(stream.frames, null, 2));
      assert.equal(approvalCount, 1, 'Expected exactly one task approval');
      assert.ok(JSON.stringify(stream.frames).includes('COMPUTER_FIXTURE_DONE'));
      if (decision === 'rejected') assert.equal(driverCalls, beforeCalls, 'Denied tool started native work');
      else {
        assert.equal(driverCalls - beforeCalls, 2, 'Expected exactly observe and click');
        assert.equal(current.imageSeen, true, 'Image did not reach the actual provider request');
        const failures = stream.frames.filter(frame => frame.event?.type === 'tool/result' && JSON.stringify(frame.event.data).includes('"isError":true'));
        assert.equal(failures.length, 0, 'Successful fixture contained tool errors');
      }
      assert.equal(broker.state.phase, 'idle');
      report.checks.push(`${face}: ${decision}; ${decision === 'rejected' ? 'denial started no native work' : 'scoped approval, provider image delivery and desktop release verified'}`);
      console.log('PASS', report.checks.at(-1));
    } catch (error) { await writeFile(join(data, `${face}-${decision}-events.json`), JSON.stringify(stream.frames, null, 2)); throw error; }
    finally { clearInterval(approvals); stream.close(); }
  }
  events.close();
} catch (error) { report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error)); }
finally {
  client?.close(); await core.stop(); await new Promise<void>(resolve => mock.close(() => resolve()));
  await writeFile(join(root, '.test-data/computer-tools-latest.json'), JSON.stringify({ ...report, data, scope: 'Real DSH core, native/invoke/PTC dispatch, approval events, attachment store and provider requests; disposable native-driver fixture.' }, null, 2));
  console.log(JSON.stringify({ ...report, data }, null, 2));
}
if (report.failures.length) process.exitCode = 1;
