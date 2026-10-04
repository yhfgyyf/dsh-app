// Entry point for disposable copies of the installed Mac/Linux applications.
// The controller and deterministic model are test-only and use fresh profiles.
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve, isAbsolute } = require('node:path');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');

const peer = process.env.DSH_CROSS_PEER;
const controller = process.env.DSH_CROSS_CONTROLLER;
const data = process.env.DSH_DESKTOP_DATA_DIR;
if (!['mac', 'ubuntu160'].includes(peer) || !controller?.startsWith('http://127.0.0.1:') || !data || !isAbsolute(data) || !resolve(data).includes('collab-cross-host-')) throw new Error('Isolated cross-host test configuration required');
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
process.env.DSH_CROSS_MODEL_KEY = 'isolated-cross-host-model';
process.env.DSH_TELEMETRY_DISABLED = '1';
mkdirSync(join(data, 'core'), { recursive: true, mode: 0o700 });
const handlers = new Map();
const original = ipcMain.handle.bind(ipcMain);
let started = false, modelCalls = 0, plans = [], contents;
const model = createServer(async (req, res) => {
  try {
    if (req.url?.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'deepseek-flash', object: 'model' }] })); return; }
    if (!req.url?.endsWith('/messages')) { res.writeHead(404); res.end('{}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); modelCalls++;
    const profile = JSON.parse(readFileSync(join(data, 'core/collaboration/profile.json')));
    const run = Object.values(profile.runs).sort((a, b) => b.startedAt - a.startedAt)[0];
    const cwd = join(data, 'core/collaboration/workspaces', run.id);
    const task = JSON.parse(readFileSync(join(cwd, 'task.json')));
    const plan = plans.shift() || { action: 'wait', summary: 'No new evidence; keep this review local.', contribution: false };
    const answer = plan.body || plan.summary;
    const files = plan.files || [];
    for (const file of files) {
      if (!/^[A-Za-z0-9_.-]+$/.test(file.name)) throw new Error('Invalid fixture artifact');
      writeFileSync(join(cwd, file.name), file.text);
    }
    writeFileSync(join(cwd, 'submission.json'), JSON.stringify({ body: answer, verification: 'Deterministic cross-host fixture', limitations: 'No external model was invoked', files: files.map(f => f.name) }));
    writeFileSync(join(cwd, 'continuation.json'), JSON.stringify({ action: plan.action, summary: plan.summary,
      nextStep: plan.action === 'wait' ? 'Check new evidence when another contribution arrives.' : plan.action === 'continue' ? 'Run the next bounded experiment.' : '',
      wakeOn: plan.action === 'wait' ? ['reply.created', 'solution.submitted', 'validation.created'] : [],
      decisions: (task.pendingEvents || []).map(event => ({ eventId: event.id, decision: plan.contribution ? 'verify' : 'reject', reason: plan.summary })),
      ...(plan.contribution ? { contribution: { summary: plan.summary } } : {}) }));
    const message = { id: randomUUID(), type: 'message', role: 'assistant', model: input.model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 128, output_tokens: 32 } };
    if (!input.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 128, output_tokens: 0 } } });
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
    emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 32 } }); emit('message_stop', {}); res.end();
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
const send = async (path, body) => {
  const response = await fetch(controller + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Controller HTTP ' + response.status);
  return response.json();
};
const js = source => contents.executeJavaScript(source, true);
const rpc = (method, args = {}, channel = '/desktop-collab') => js(`(async()=>{const method=${JSON.stringify(method)},rpcId=crypto.randomUUID();const response=await fetch(${JSON.stringify(channel + '/' + method)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method,payload:{args:${JSON.stringify(args)}}})});const body=await response.json();if(!body.result.ok)throw Error(JSON.stringify(body.result.error));return body.result.value;})()`);
const until = async (check, message, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 150)); }
  throw new Error(message);
};
const click = text => js(`(()=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('Button missing: '+${JSON.stringify(text)});button.click();})()`);
async function execute(command) {
  if (command.type === 'rpc') return rpc(command.method, command.args, command.channel);
  if (command.type === 'plans') { plans = command.plans; return { queued: plans.length }; }
  if (command.type === 'stats') return { modelCalls, appVersion: app.getVersion(), platform: process.platform, data };
  if (command.type === 'evidence') {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(command.runId)) throw new Error('Invalid run id');
    const cwd = join(data, 'core/collaboration/workspaces', command.runId);
    const task = JSON.parse(readFileSync(join(cwd, 'task.json')));
    return { attachments: task.discussion.flatMap(reply => reply.attachments.map(file => ({ ...file, ...(file.path?.startsWith('inputs/') && !file.path.includes('..') ? { text: readFileSync(join(cwd, file.path), 'utf8') } : {}) }))) };
  }
  if (command.type === 'inbox-latest') {
    if (!await js(`!!document.querySelector('[data-testid="collab-page"]')`)) await click('协作空间');
    if (await js(`!!document.querySelector('[data-collab-detail]')`)) await click('← 返回列表');
    await click('刷新消息');
    await until(() => js(`Array.from(document.querySelectorAll('.collab-tabs button')).some(b=>b.textContent.startsWith('消息'))`), 'Inbox navigation unavailable');
    await js(`Array.from(document.querySelectorAll('.collab-tabs button')).find(b=>b.textContent.startsWith('消息')).click()`);
    await until(() => js(`!!document.querySelector('.collab-task.unread')`), 'No unread inbox item');
    await js(`document.querySelector('.collab-task.unread').click()`);
    await until(() => js(`document.querySelector('.collab-detail')?.innerText.includes(${JSON.stringify(command.expected)})`), 'Inbox failed to locate contribution');
    return { found: true, text: await js(`document.querySelector('.collab-detail').innerText`) };
  }
  if (command.type === 'capture') {
    const window = BrowserWindow.fromWebContents(contents); window.show(); window.focus();
    const file = join(data, `${peer}-workflow.png`); writeFileSync(file, (await contents.capturePage()).toPNG()); return { file };
  }
  if (command.type === 'quit') { setTimeout(() => app.quit(), 500); return { closed: true }; }
  throw new Error('Unknown test command');
}
async function run(event) {
  if (app.getPath('userData') !== resolve(data)) throw new Error('Test userData isolation was not applied');
  contents = event.sender;
  BrowserWindow.fromWebContents(contents).setSize(1220, 900); contents.setBackgroundThrottling(false);
  await until(() => js(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>['继续','Continue','稍后配置','Configure later'].includes(b.textContent));if(b){if(!b.disabled)b.click();return false;}return document.getElementById('root')?.inert===false&&!!document.querySelector('[contenteditable="true"][data-phase="plain"]');})()`), 'Initial app UI not ready', 60000);
  const config = await send('/config?peer=' + peer);
  await handlers.get('desktop:remote-action')(event, { type: 'configure', config: { relay: config.relay, name: 'Cross-host ' + peer, enabled: false, background: true, sessionOnly: true } });
  await handlers.get('desktop:remote-action')(event, { type: 'register', code: config.code });
  await rpc('pluginManager/setBundleEnabled', { name: 'dsh-p2p-collab', enabled: true }, '/api');
  await rpc('sync');
  await rpc('profile', { nickname: 'Workflow ' + peer, maxTokens: 4000, maxMinutes: 10, executionMode: 'manual', publishMode: 'review' });
  await send('/ready', { peer, appVersion: app.getVersion(), platform: process.platform, data });
  for (;;) {
    const command = await send('/next?peer=' + peer);
    if (!command.id) { await new Promise(r => setTimeout(r, 100)); continue; }
    try { await send('/result', { peer, id: command.id, value: await execute(command) }); }
    catch (error) { await send('/result', { peer, id: command.id, error: String(error.stack || error) }); }
    if (command.type === 'quit') break;
  }
}
ipcMain.handle = (channel, handler) => {
  handlers.set(channel, handler);
  return original(channel, async (...args) => {
    const result = await handler(...args);
    if (channel === 'desktop:ready' && !started) {
      started = true;
      setTimeout(() => run(args[0]).catch(async error => {
        writeFileSync(join(data, 'failure.txt'), String(error.stack || error));
        await send('/failure', { peer, error: String(error.stack || error) }).catch(() => {}); app.quit();
      }), 100);
    }
    return result;
  });
};
app.on('quit', () => model.close());
setTimeout(() => app.quit(), 10 * 60 * 1000).unref();
model.listen(0, '127.0.0.1', () => {
  writeFileSync(join(data, 'core/desktop.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${model.address().port}\n    apiKeyEnv: DSH_CROSS_MODEL_KEY\n    maxTokens: 4096\n`);
  writeFileSync(join(data, 'core/settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n');
  require(join(__dirname, '../dist/main/index.cjs'));
});
