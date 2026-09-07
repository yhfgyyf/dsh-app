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
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model', owned_by: 'desktop-test' }] }));
    return;
  }
  if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
  const request = JSON.parse(body);
  requests++;
  // Retain the test-owned requests to verify actual tool and attachment transport.
  await writeFile(join(data, `request-${requests}.json`), JSON.stringify(request, null, 2), { mode: 0o600 });
  const isHuman = (message: { role: string; content: unknown }) => message.role === 'user' && !JSON.stringify(message.content).includes('Current runtime context.') && !JSON.stringify(message.content).includes('<system-reminder>');
  const lastUser = [...(request.messages ?? [])].reverse().find(isHuman);
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
  const lastUserIndex = (request.messages ?? []).findLastIndex(isHuman);
  const step = request.messages.slice(lastUserIndex + 1).filter((message: { role: string }) => message.role === 'tool').length;
  const question = prompt.includes('[desktop-question]');
  const approval = prompt.match(/\[desktop-approval:([a-f0-9-]+)\]/)?.[1];
  const advanced = prompt.match(/\[desktop-(workflow|subagent|jobs|cordis)\]/)?.[1];
  const target = question ? 'ask_user_question' : approval ? 'write' : advanced === 'jobs' ? 'bash' : advanced === 'cordis' ? 'cordis_define' : advanced ?? 'read';
  const toolArguments = advanced === 'workflow' ? { meta: { name: 'desktop-workflow', description: 'Isolated desktop workflow acceptance', phases: [{ title: '验收' }] }, script: 'phase("验收"); log("desktop-workflow-running"); const result = await agent("Return a simple desktop child test reply.", {label:"desktop-child"}); return {verified: true, result};' } : advanced === 'subagent' ? { description: 'desktop child acceptance', prompt: 'Return a simple desktop child test reply.', run_in_background: false } : advanced === 'jobs' ? { command: 'printf desktop-background-job', description: 'Print isolated desktop background job result', workdir: workspace, run_in_background: true } : undefined;
  const sequence: { name: string; arguments: any }[] = [
    { name: 'search_tools', arguments: { query: target } },
    { name: 'describe_tools', arguments: { names: [target] } },
    { name: 'invoke_tool', arguments: { name: target, arguments: toolArguments ?? (question ? { questions: [{ id: 'desktop-choice', question: '请选择桌面测试结果', header: '桌面验收', options: [{ label: '通过', description: '继续测试' }, { label: '重试', description: '重新执行' }] }] } : approval ? { file_path: join(data, `approval-${approval}.txt`), content: 'Desktop one-time approval verified.\n' } : { file_path: join(workspace, 'README.md') }) } },
  ];
  if (advanced === 'cordis') sequence[2].arguments.arguments = { plugin: { kind: 'new', idPrefix: 'dshtst' }, name: 'Desktop lifecycle fixture', purpose: 'Verify an isolated dynamic plugin can be defined, run and stopped.', code: { host: 'return { apply() {} };' } };
  if (approval) sequence.push({ name: 'invoke_tool', arguments: { name: target, arguments: { file_path: join(data, `approval-${approval}.txt`), content: 'Desktop one-time approval verified.\n', sandbox_permissions: 'danger-full-access', justification: '仅在隔离测试目录创建这个验收文件，以验证桌面单次审批。' } } } as typeof sequence[number]);
  if (request.stream && (question || approval || advanced || prompt.includes('[desktop-tools]')) && step < sequence.length) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const call = sequence[step];
    const frame = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'desktop-tool-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.write(frame({ role: 'assistant', reasoning_content: '执行隔离的桌面功能验收。' }, null));
    res.write(frame({ tool_calls: [{ index: 0, id: `desktop_call_${requests}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, null));
    res.end(frame({}, 'tool_calls') + 'data: [DONE]\n\n');
    return;
  }
  const content = prompt.includes('长消息') ? '这是一条用于滚动测试的消息。\n\n'.repeat(150) : '已收到桌面测试消息。\n\n**中文与 Markdown 渲染正常。**\n\n```typescript\nconst message = "Hello, DSH Desktop";\nconsole.log(message);\n```\n\n- 会话与工作空间已连接\n- 流式回复已完成\n\n这是本地确定性测试响应。';
  if (!request.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'desktop-fixture', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (delta: object, finish_reason: string | null = null, usage?: object) => res.write(`data: ${JSON.stringify({ id: 'desktop-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  emit({ role: 'assistant', reasoning_content: '检查桌面测试输入并生成确定性响应。' });
  const pieces = content.match(/[\s\S]{1,12}/g) ?? [];
  const timer = setInterval(() => {
    const piece = pieces.shift();
    if (piece !== undefined) emit({ content: piece });
    else {
      clearInterval(timer);
      emit({}, 'stop', { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192, prompt_cache_hit_tokens: 32, prompt_cache_miss_tokens: 96 });
      res.end('data: [DONE]\n\n');
    }
  }, prompt.includes('慢速') ? 500 : 35);
  res.on('close', () => clearInterval(timer));
});
await new Promise<void>((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
const mockPort = (mock.address() as { port: number }).port;
await writeFile(join(home, 'desktop.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${mockPort}\n    apiKeyEnv: DSH_DESKTOP_FIXTURE_KEY\n    maxTokens: 4096\n- id: agent-presets\n  config:\n    default: standard\n`);
process.env.DSH_DESKTOP_FIXTURE_KEY = 'desktop-local-fixture';
const core = new DesktopRuntime({ runtimeRoot: join(root, '.runtime'), entry: join(root, '.runtime/app/index.ts'), home, cwd: workspace, onExit: code => { mock.close(); process.exitCode = code ?? 1; } });
const ready = await core.start();
await writeFile(join(data, 'fixture-connection.json'), JSON.stringify({ owner: 'dsh-desktop-test', ...ready, pid: core.child!.pid, mockPort }), { mode: 0o600 });
console.log(`Independent desktop fixture ready (${ready.graph.entries.length} client modules).`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void core.stop().finally(() => mock.close()); });
