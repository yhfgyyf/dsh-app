import { createServer } from 'node:http';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = resolve(root, '.test-data');
const home = join(data, 'fixture-owned');
const workspace = join(data, 'workspace');
await mkdir(home, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'README.md'), '# Desktop test workspace\n\n这是独立的 DSH 桌面功能测试目录。\n');
await writeFile(join(workspace, 'example.ts'), 'export const greeting = "你好，DSH Desktop";\n');

let requests = 0;
const mock = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'desktop-test' }] }));
    return;
  }
  if (!req.url?.endsWith('/messages')) { res.writeHead(404); res.end('{}'); return; }
  const request = JSON.parse(body);
  requests++;
  // Retain the test-owned requests to verify actual tool and attachment transport.
  await writeFile(join(data, `request-${requests}.json`), JSON.stringify(request, null, 2), { mode: 0o600 });
  // Messages coalesces consecutive user messages. Ignore injected context per
  // block, otherwise the first actual prompt disappears from the fixture.
  const humanText = (message: { content: any }) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((block: any) => block.type === 'text' && !block.text.startsWith('Current runtime context.') && !block.text.startsWith('<system-reminder>')).map((block: any) => block.text).join('\n');
  const isHuman = (message: { role: string; content: any }) => message.role === 'user' && humanText(message) !== '';
  const lastUser = [...(request.messages ?? [])].reverse().find(isHuman);
  const prompt = lastUser ? humanText(lastUser) : '';
  const lastUserIndex = (request.messages ?? []).findLastIndex(isHuman);
  const step = request.messages.slice(lastUserIndex + 1).flatMap((message: { content: any }) => Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'tool_result') : []).length;
  const question = prompt.includes('[desktop-question]');
  const approval = prompt.match(/\[desktop-approval:([a-f0-9-]+)\]/)?.[1];
  const advanced = prompt.match(/\[desktop-(workflow|subagent|jobs|cordis)\]/)?.[1];
  const target = question ? 'ask_user_question' : approval ? 'write' : advanced === 'jobs' ? 'bash' : advanced === 'cordis' ? 'cordis_inspect_list' : advanced ?? 'read';
  const toolArguments = advanced === 'workflow' ? { meta: { name: 'desktop-workflow', description: 'Isolated desktop workflow acceptance', phases: [{ title: '验收' }] }, script: 'phase("验收"); log("desktop-workflow-running"); const result = await agent("Return a simple desktop child test reply.", {label:"desktop-child"}); return {verified: true, result};' } : advanced === 'subagent' ? { description: 'desktop child acceptance', prompt: 'Return a simple desktop child test reply.', run_in_background: false } : advanced === 'jobs' ? { command: 'printf desktop-background-job', description: 'Print isolated desktop background job result', workdir: workspace, run_in_background: true } : undefined;
  const sequence: { name: string; arguments: any }[] = [
    { name: 'search_tools', arguments: { query: target } },
    { name: 'describe_tools', arguments: { names: [target] } },
    { name: 'invoke_tool', arguments: { name: target, arguments: toolArguments ?? (question ? { questions: [{ id: 'desktop-choice', question: '请选择桌面测试结果', header: '桌面验收', options: [{ label: '通过', description: '继续测试' }, { label: '重试', description: '重新执行' }] }] } : approval ? { file_path: join(data, `approval-${approval}.txt`), content: 'Desktop one-time approval verified.\n' } : { file_path: join(workspace, 'README.md') }) } },
  ];
  if (advanced === 'cordis') {
    sequence[2].arguments.arguments = {};
    sequence.push({ name: 'invoke_tool', arguments: { name: 'cordis_inspect_query', arguments: { platform: 'host', provider: 'Tool', method: 'listTools' } } });
  }
  if (approval) sequence.push({ name: 'invoke_tool', arguments: { name: target, arguments: { file_path: join(data, `approval-${approval}.txt`), content: 'Desktop one-time approval verified.\n', sandbox_permissions: 'danger-full-access', justification: '仅在隔离测试目录创建这个验收文件，以验证桌面单次审批。' } } } as typeof sequence[number]);
  const call = (question || approval || advanced || prompt.includes('[desktop-tools]')) && step < sequence.length ? sequence[step] : undefined;
  const content = prompt.includes('长消息') ? '这是一条用于滚动测试的消息。\n\n'.repeat(150) : '已收到桌面测试消息。\n\n**中文与 Markdown 渲染正常。**\n\n```typescript\nconst message = "Hello, DSH Desktop";\nconsole.log(message);\n```\n\n- 会话与工作空间已连接\n- 流式回复已完成\n\n这是本地确定性测试响应。';
  if (!request.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'desktop-fixture', type: 'message', role: 'assistant', model: request.model, content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 128, output_tokens: 64 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('message_start', { message: { id: 'desktop-fixture', type: 'message', role: 'assistant', model: request.model, content: [], usage: { input_tokens: 128, output_tokens: 0, cache_read_input_tokens: 32 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '检查桌面测试输入并生成确定性响应。' } });
  emit('content_block_stop', { index: 0 });
  emit('content_block_start', { index: 1, content_block: call ? { type: 'tool_use', id: `desktop_call_${requests}`, name: call.name, input: {} } : { type: 'text', text: '' } });
  const finish = () => {
    emit('content_block_stop', { index: 1 });
    emit('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 64 } });
    emit('message_stop', {}); res.end();
  };
  if (call) {
    emit('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } });
    finish(); return;
  }
  const pieces = content.match(/[\s\S]{1,12}/g) ?? [];
  const timer = setInterval(() => {
    const piece = pieces.shift();
    if (piece !== undefined) emit('content_block_delta', { index: 1, delta: { type: 'text_delta', text: piece } });
    else { clearInterval(timer); finish(); }
  }, prompt.includes('慢速') ? 500 : 35);
  res.on('close', () => clearInterval(timer));
});
await new Promise<void>((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
const mockPort = (mock.address() as { port: number }).port;
await writeFile(join(home, 'desktop.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${mockPort}\n    apiKeyEnv: DSH_DESKTOP_FIXTURE_KEY\n    maxTokens: 4096\n- id: agent-preset-registry\n  config:\n    default: standard\n`);
process.env.DSH_DESKTOP_FIXTURE_KEY = 'desktop-local-fixture';
const core = new DesktopRuntime({ runtimeRoot: join(root, '.runtime'), entry: join(root, '.runtime/app/index.ts'), home, cwd: workspace, onExit: code => { mock.close(); process.exitCode = code ?? 1; } });
const ready = await core.start();
await writeFile(join(data, 'fixture-connection.json'), JSON.stringify({ owner: 'dsh-desktop-test', ...ready, pid: core.child!.pid, mockPort }), { mode: 0o600 });
console.log(`Independent desktop fixture ready (${ready.graph.entries.length} client modules).`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void core.stop().finally(() => mock.close()); });
