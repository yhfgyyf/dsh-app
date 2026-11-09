const { app, ipcMain, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, cpSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { createServer } = require('node:http');
const { zstdCompressSync } = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const root = resolve(__dirname, '..');
const appRoot = process.env.DSH_SIDE_CHAT_APP_ROOT;
const surface = process.env.DSH_SIDE_CHAT_SURFACE ?? 'desktop';
const web = surface === 'web';
const baseline = process.env.DSH_SIDE_CHAT_TEST_BASELINE === '1';
const contentTools = process.env.DSH_DESKTOP_CONTENT_TOOLS_TEST === '1';
const variant = contentTools ? 'content-tools' : baseline ? 'baseline-' + surface : surface;
assert.ok(appRoot && JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).name === 'dsh-app');
const reports = join(root, '.test-data');
mkdirSync(reports, { recursive: true });
const data = mkdtempSync(join(reports, variant + '-'));
const home = join(data, 'core'), profile = join(home, 'profiles', web ? 'web' : 'desktop'), workspace = join(data, 'workspace');
mkdirSync(workspace, { recursive: true });
mkdirSync(join(profile, 'node_modules'), { recursive: true });
cpSync(join(root, 'dist/package'), join(profile, 'node_modules/dsh-side-chat'), { recursive: true });
const driver = join(profile, 'node_modules/dsh-side-chat-test-driver');
mkdirSync(driver);
writeFileSync(join(driver, 'package.json'), JSON.stringify({ name: 'dsh-side-chat-test-driver', version: '0.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: baseline ? [] : ['dsh-side-chat'] } } }));
writeFileSync(join(driver, 'index.js'), 'export function apply() {}\n');
writeFileSync(join(driver, 'cordis.patch.yml'), '- insert:\n    - name: dsh-side-chat-test-driver\n');
const driverInject = ['sessions', 'conversation', 'uiWorkspace', 'remote', ...baseline ? [] : ['remote.sideChat']];
writeFileSync(join(driver, 'client.js'), `window.__ModuleLoader__.load({id:"dsh-side-chat-test-driver",factory:()=>({inject:${JSON.stringify(driverInject)},apply(ctx){window.__dshSideChatTest=ctx;ctx.effect(()=>()=>{delete window.__dshSideChatTest;});}})});\n`);
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + surface, private: true, dependencies: { ...baseline ? {} : { 'dsh-side-chat': 'file:' + join(root, 'dist/package') }, 'dsh-side-chat-test-driver': 'file:' + driver }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', web ? '@deepseek-ai/dsh-web-app' : 'dsh-desktop-surface', ...baseline ? [] : ['dsh-side-chat'], 'dsh-side-chat-test-driver'] } } }, null, 2));
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = home;
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_DISABLED = '1';
process.env.DSH_DESKTOP_FIXTURE_KEY = 'side-chat-local-fixture';
if (web) {
  app.setPath('userData', data);
  mkdirSync(join(profile, 'local-plugins'));
  writeFileSync(join(profile, 'local-plugins/package.json'), '{"private":true}\n');
}
const report = { surface, baseline, checks: [], failures: [], console: [], frameworkDiagnostics: [], data };
const startupFixtures = [];
if (!baseline) {
  // Physical V4 logs exercise the real cold-read validator and deletion API.
  // The first artifact reproduces the Windows activation error; the next is
  // a healthy abandoned side which must still be cleaned up on the same boot.
  const fixtureCwd = resolve('/', 'dsh-side-chat-startup-fixture');
  const project = '--' + fixtureCwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '') + '--';
  for (const corrupt of [true, false]) {
    const id = 'session-' + randomUUID(), parentId = 'session-' + randomUUID();
    const directory = join(home, 'sessions', project, id);
    mkdirSync(directory, { recursive: true });
    const header = { type: 'session', version: 4, id, createdAt: 0, cwd: fixtureCwd, parentSession: parentId, isSeeded: false, delegationDepth: 0 };
    const rows = [
      { type: 'user/message', data: { id: 'fixture-question', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture question' }] }, surfaceOp: 'append' },
      ...corrupt ? [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        { type: 'system/message', data: { turn: 1, step: 1, message: { id: 'fixture-system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'fixture policy' }] } }, surfaceOp: 'append' },
      ] : [],
    ].map((row, seq) => ({ seq, time: seq, ...row }));
    const log = Buffer.concat([zstdCompressSync(JSON.stringify(header) + '\n'), zstdCompressSync(rows.map(row => JSON.stringify(row)).join('\n') + '\n')]);
    const marker = JSON.stringify({ version: 2, parentId, childId: id, leaseId: randomUUID(), visibleFromSeq: rows.length });
    writeFileSync(join(directory, 'session.v4.jsonl.zstd'), log);
    writeFileSync(join(directory, '.dsh-side-chat-v2.json'), marker);
    startupFixtures.push({ id, directory, log, marker, corrupt });
  }
}
const requests = [];
let releaseParent, advanceParent, finished = false, started = false, failureCode = 0, webChild, webUrl, webLog = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error(label);
}
const mock = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] })); return; }
  if (!req.url.endsWith('/messages')) { res.writeHead(404); res.end('{}'); return; }
  let body = '';
  for await (const bytes of req) body += bytes;
  const request = JSON.parse(body);
  const texts = request.messages.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text));
  const lastUser = [...request.messages].reverse().find(message => message.role === 'user');
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content : (lastUser?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const titleRequest = JSON.stringify(request.system).includes('Create a concise title');
  const question = titleRequest ? 'title' : prompt.includes('SIDE_SLOW_QUESTION') ? 'slow-side' : prompt.includes('SIDE_REFRESH_QUESTION') ? 'refresh' : prompt.includes('SIDE_FOLLOWUP') ? 'followup' : prompt.includes('SIDE_INLINE_QUESTION') ? 'side' : prompt.includes('PARENT_RUNNING') ? 'parent' : 'other';
  requests.push({ question, request });
  const context = texts.join('\n');
  const answer = question === 'refresh' ? JSON.stringify(request).includes('PARENT_PROGRESS_BETA') ? 'SIDE_PROGRESS_OK' : 'SIDE_PROGRESS_MISSING' : question === 'side' ? context.includes('CONTEXT_TOKEN_ALPHA') ? 'SIDE_CONTEXT_OK' : 'SIDE_CONTEXT_MISSING' : question === 'followup' ? context.includes('SIDE_CONTEXT_OK') ? 'SIDE_FOLLOWUP_OK' : 'SIDE_FOLLOWUP_MISSING' : question === 'parent' ? 'PARENT_FINISHED' : 'Local fixture';
  const message = { id: randomUUID(), type: 'message', role: 'assistant', model: request.model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 128, output_tokens: 32 } };
  if (!request.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 128, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  const end = () => {
    if (res.destroyed) return;
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 32 } });
    emit('message_stop', {}); res.end();
  };
  if (question === 'parent') {
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PARENT_STARTED ' } });
    advanceParent = () => emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PARENT_PROGRESS_BETA ' } });
    releaseParent = end;
  } else if (question === 'slow-side') {
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'SIDE_RUNNING ' } });
    res.once('close', () => { report.sideStreamClosed = true; });
  } else setTimeout(end, 30);
});
async function finish(error) {
  if (finished) return;
  finished = true;
  if (error) { report.failures.push(String(error.stack ?? error).replace(/token=[^\s&"']+/g, 'token=[redacted]')); failureCode = 1; }
  clearTimeout(deadline);
  report.requests = requests.map(row => ({ question: row.question, model: row.request.model, stream: row.request.stream }));
  if (error && web) report.webLog = webLog.slice(-3000);
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(reports, 'latest.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(reports, 'latest-' + variant + '.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  mock.closeAllConnections(); mock.close();
  if (webChild && webChild.exitCode === null) {
    const stopped = new Promise(resolve => webChild.once('exit', resolve));
    webChild.kill('SIGTERM');
    const timeout = setTimeout(() => webChild.kill('SIGKILL'), 5000);
    await stopped; clearTimeout(timeout);
  }
  app.quit();
}
const deadline = setTimeout(() => finish(new Error('Side chat App test timed out')), 100000);
app.on('quit', () => { if (failureCode) process.exit(failureCode); });
app.on('web-contents-created', (_event, contents) => contents.on('console-message', details => {
  if (details.level !== 'error') return;
  const message = String(details.message).replace(/token=[^\s&"']+/g, 'token=[redacted]');
  // This exact disconnect diagnostic also occurs in the native no-plugin
  // reload baseline. Preserve it separately from plugin/renderer failures.
  if (!baseline && report.reloaded && [
    '[cordis-client-runner] syncing inspect providers failed: Error: client api: dynamicCordisRunner/syncInspectManifest has no active Connection',
    '[cordis-client-runner] syncing inspect providers failed: Error: gateway/cancelled: client api: Remote invocation "dynamicCordisRunner/syncInspectManifest" was aborted',
  ].includes(message)) {
    report.frameworkDiagnostics.push(message); return;
  }
  report.console.push(message);
  if (message.includes('模块未激活：dsh-side-chat')) void finish(new Error('The standalone side-chat plugin failed to activate'));
}));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  const result = await listener(...args);
  if (channel === 'desktop:ready' && !started) {
    started = true;
    setTimeout(() => run(args[0].sender).then(() => finish()).catch(async error => {
      report.ui = await args[0].sender.executeJavaScript(`(()=>{const ctx=window.__dshSideChatTest;const ids=${JSON.stringify([report.parentId ?? '',report.childId ?? ''])};return {text:document.body.innerText.slice(0,5000),titles:[...document.querySelectorAll('[title]')].map(el=>el.title),bindings:ids.map(id=>{const binding=ctx?.sessions.binding(id);return {id,state:binding?.session.getSnapshot(),scopeId:binding&&ctx.sessions.scopeOf(binding.ctx),input:binding&&ctx.conversation.input.for(binding.ctx).state.getSnapshot(),events:binding?.eventSource.getSnapshot().entries.filter(entry=>entry.type==='event').map(entry=>entry.event)};})};})()`).catch(() => null);
      finish(error);
    }), 250);
  }
  return result;
});
async function run(host) {
  const window = BrowserWindow.fromWebContents(host);
  window.setSize(1360, 860); host.setBackgroundThrottling(false);
  const js = code => host.executeJavaScript(code, true);
  if (web) {
    assert.equal(await js('typeof window.dshDesktop'), 'undefined');
    assert.equal(await js('typeof window.require'), 'undefined');
    assert.equal(new URL(host.getURL()).protocol, 'http:');
    assert.ok(await js('!!window.__DSH_BOOT__'));
    report.checks.push('Native dsh --profile web serves the real Web frontend without a Desktop preload or Node integration');
  }
  await js(`Array.from(document.querySelectorAll('button')).find(button=>['继续','Continue'].includes(button.textContent))?.click()`);
  await until(() => js('!!window.__dshSideChatTest'), 'Test driver did not load through the plugin graph');
  if (!baseline) {
    const corrupt = startupFixtures.find(fixture => fixture.corrupt);
    const healthy = startupFixtures.find(fixture => !fixture.corrupt);
    assert.deepEqual(readFileSync(join(corrupt.directory, 'session.v4.jsonl.zstd')), corrupt.log);
    assert.equal(readFileSync(join(corrupt.directory, '.dsh-side-chat-v2.json'), 'utf8'), corrupt.marker);
    assert.throws(() => readFileSync(join(healthy.directory, 'session.v4.jsonl.zstd')), { code: 'ENOENT' });
    report.preservedCorruptSessionId = corrupt.id;
    report.preservedCorruptMarker = join(corrupt.directory, '.dsh-side-chat-v2.json');
    report.checks.push('A corrupt stored side does not block activation; its log and marker are unchanged while another healthy abandoned side is deleted');
  }
  const parentId = await js(`(async()=>{const ctx=window.__dshSideChatTest;const id=await ctx.sessions.create({cwd:${JSON.stringify(workspace)}});ctx.uiWorkspace.openSession(id);return id;})()`);
  report.parentId = parentId;
  await until(() => js(`window.__dshSideChatTest.sessions.binding(${JSON.stringify(parentId)})?.session.getSnapshot().openState==='open'`), 'Main session did not open');
  const submit = (id, text) => js(`(()=>{const ctx=window.__dshSideChatTest;const input=ctx.conversation.input.for(ctx.sessions.scope(${JSON.stringify(id)}));input.setDraft(${JSON.stringify(text)});input.submit();})()`);
  const running = id => js(`window.__dshSideChatTest.sessions.binding(${JSON.stringify(id)})?.session.getSnapshot().running`);
  // Title generation and log-delivery receipts advance independently of chat work.
  const entries = id => js(`window.__dshSideChatTest.sessions.binding(${JSON.stringify(id)})?.eventSource.getSnapshot().entries.filter(entry=>entry.type==='event'&&!entry.event.type.startsWith('session/title')&&entry.event.type!=='session-log-deepseek/delivery-accepted').map(entry=>entry.event)`);
  await submit(parentId, 'PARENT_RUNNING CONTEXT_TOKEN_ALPHA');
  await until(() => releaseParent && running(parentId), 'The mock parent turn did not start');
  if (baseline) {
    assert.equal(await js(`!!document.querySelector('button[aria-label="打开侧聊"]')`), false);
    host.reload();
    await until(() => js('!!window.__dshSideChatTest'), 'The native baseline did not reload');
    await until(() => running(parentId), 'The native baseline lost its running turn');
    releaseParent();
    await until(async () => !(await running(parentId)), 'The native baseline turn did not complete');
    report.checks.push('Reloading the native frontend without the side-chat plugin preserves its main turn');
    return;
  }
  await until(() => js(`!!document.querySelector('button[aria-label="打开侧聊"]')`), 'Plugin header action did not mount after the conversation started');
  if (contentTools) {
    await require(process.env.DSH_DESKTOP_CONTENT_TOOLS_MODULE || './content-tools.cjs').run({ host, js, until, parentId, workspace, requests, report, data });
    releaseParent();
    await until(async () => !(await running(parentId)), 'Parent failed to finish after content tests');
    assert.deepEqual(report.console, []);
    return;
  }
  const originalTab = await js(`(()=>{const ctx=window.__dshSideChatTest;const sidebar=ctx.get('sidebarRight');sidebar.openTab('files');return sidebar.active();})()`);
  assert.equal(originalTab.kind, 'files');
  const before = await entries(parentId);
  report.checks.push('Host and renderer discover the standalone plugin; header action mounts in the native conversation');
  const preflight = await js(`(async()=>{const ctx=window.__dshSideChatTest;const binding=ctx.sessions.binding(${JSON.stringify(parentId)});const atSeq=binding.eventSource.getSnapshot().entries.filter(row=>row.type==='event').at(-1).event.seq;const opened=await ctx.get('remote').sideChat.open({parentId:${JSON.stringify(parentId)},atSeq});if(!opened.ok)return {ok:false,error:opened.error.message};const closed=await ctx.get('remote').sideChat.discard(opened.value);return closed.ok?{ok:true}:{ok:false,error:closed.error.message};})()`);
  assert.equal(preflight.ok, true, 'Temporary side Host RPC failed: ' + preflight.error);
  await js(`document.querySelector('button[aria-label="打开侧聊"]').click()`);
  const emptyChild = await until(() => js(`document.querySelector('[data-side-chat-session]')?.getAttribute('data-side-chat-session')`), 'Bare /side did not open a side panel');
  await until(() => js(`window.__dshSideChatTest.sessions.binding(${JSON.stringify(emptyChild)})?.session.getSnapshot().openState==='open'`), 'Blank side did not finish opening');
  const emptyText = await js(`document.querySelector('[data-side-chat-session]').innerText`);
  assert.ok(!emptyText.includes('PARENT_RUNNING') && !emptyText.includes('CONTEXT_TOKEN_ALPHA'), 'Opening side chat incorrectly displays the inherited parent transcript');
  assert.equal(requests.filter(row => row.question !== 'parent' && row.question !== 'title').length, 0);
  await js('document.fonts.ready');
  writeFileSync(join(data, 'side-chat-empty.png'), (await host.capturePage()).toPNG());
  report.checks.push('Opening side chat displays an empty native transcript and makes no model call');
  await submit(parentId, '/side SIDE_INLINE_QUESTION');
  let childId = await until(() => js(`document.querySelector('[data-side-chat-session]')?.getAttribute('data-side-chat-session')`), '/side with a question did not open the right pane');
  report.childId = childId;
  assert.equal(childId, emptyChild);
  assert.notEqual(childId, parentId);
  assert.ok(await js(`window.__dshSideChatTest.get('sidebarRight').tabsIn(${JSON.stringify(parentId)}).some(tab=>tab.id===${JSON.stringify(originalTab.id)}&&tab.kind==='files')`));
  await until(() => js(`document.querySelector('[data-side-chat-session]')?.innerText.includes('SIDE_CONTEXT_OK')`), 'Side reply did not contain the inherited context');
  assert.equal(await running(parentId), true);
  assert.deepEqual(await entries(parentId), before);
  assert.equal(await js(`document.querySelector('[data-side-chat-session]').innerText.includes('CONTEXT_TOKEN_ALPHA')`), false);
  assert.equal(await js(`document.querySelector('[data-side-chat-session]').innerText.includes('PARENT_RUNNING')`), false);
  assert.ok(JSON.stringify(requests.find(row => row.question === 'side').request).includes('reference context only'));
  assert.equal(await js(`document.body.innerText.split('\\n').filter(line=>line.trim()==='侧聊').length`), 1, 'A temporary side appeared as an ordinary chat-list record');
  assert.equal(await js(`window.__dshSideChatTest.sessions.scopeOf(window.__dshSideChatTest.sessions.binding(${JSON.stringify(childId)}).ctx)`), childId);
  report.checks.push('Inline /side uses inherited reference context without displaying parent records or continuing the parent task; parent events stay unchanged');
  assert.equal(await js(`!!document.querySelector('.dsh-side-chat-bar')`), false);
  await submit(childId, 'SIDE_FOLLOWUP');
  await until(() => js(`document.querySelector('[data-side-chat-session]')?.innerText.includes('SIDE_FOLLOWUP_OK')`), 'Native side composer could not continue the side conversation');
  assert.equal(await running(parentId), true);
  assert.deepEqual(await entries(parentId), before);
  report.checks.push('The embedded native conversation supports streaming and a second question with its own history');
  advanceParent();
  await until(() => js(`document.body.innerText.includes('PARENT_PROGRESS_BETA')`), 'Main progress did not reach the frontend');
  await submit(childId, 'SIDE_REFRESH_QUESTION');
  await until(() => js(`document.querySelector('[data-side-chat-session]')?.innerText.includes('SIDE_PROGRESS_OK')`), 'Side follow-up did not receive the current main streaming progress');
  assert.ok(!await js(`document.querySelector('[data-side-chat-session]').innerText.includes('PARENT_PROGRESS_BETA')`), 'Parent progress leaked into the visible side transcript');
  assert.deepEqual(await entries(parentId), before);
  report.checks.push('A later side question sees newly streamed main progress as hidden reference context while the main turn stays running');
  await js(`document.querySelector('[data-sidebar-right-toggle]').click()`);
  await until(() => js(`!window.__dshSideChatTest.sessions.list.getSnapshot().byId[${JSON.stringify(childId)}]`), 'Collapsing the native sidebar kept the temporary side session alive');
  await submit(parentId, '/side');
  const afterCollapse = await until(() => js(`(()=>{const id=document.querySelector('[data-side-chat-session]')?.getAttribute('data-side-chat-session');return id&&id!==${JSON.stringify(childId)}?id:null;})()`), 'Side did not reopen with a fresh identity after collapse');
  assert.notEqual(afterCollapse, childId);
  const reopenedText = await js(`document.querySelector('[data-side-chat-session]').innerText`);
  assert.ok(!reopenedText.includes('SIDE_CONTEXT_OK') && !reopenedText.includes('SIDE_FOLLOWUP_OK') && !reopenedText.includes('SIDE_PROGRESS_OK'));
  childId = afterCollapse;
  report.childId = childId;
  report.checks.push('The actual sidebar collapse control discards the temporary side; reopening starts a new blank conversation');
  await submit(childId, '/side forbidden nested question');
  await until(() => js(`(()=>{const ctx=window.__dshSideChatTest;const state=ctx.conversation.input.for(ctx.sessions.scope(${JSON.stringify(childId)})).state.getSnapshot();return state.phase==='plain'&&document.querySelector('[data-side-chat-session] [contenteditable="true"]')?.textContent==='/side forbidden nested question';})()`), 'Nested side command was not refused while preserving its draft');
  assert.equal(requests.filter(row => row.question === 'side').length, 1);
  await js(`window.__dshSideChatTest.conversation.input.for(window.__dshSideChatTest.sessions.scope(${JSON.stringify(childId)})).setDraft('')`);
  await submit(parentId, '/side');
  await sleep(200);
  assert.equal(await js(`document.querySelector('[data-side-chat-session]')?.getAttribute('data-side-chat-session')`), childId);
  report.checks.push('Bare /side reuses the open branch; nested /side remains in the side draft and makes no model call');
  await js('document.fonts.ready');
  await until(() => js(`!document.body.innerText.includes('侧聊中不能再开启侧聊')`), 'Refusal toast did not dismiss');
  writeFileSync(join(data, 'side-chat.png'), (await host.capturePage()).toPNG());
  await submit(childId, 'SIDE_SLOW_QUESTION');
  await until(async () => requests.some(row => row.question === 'slow-side') && await running(childId), 'Slow side turn did not start');
  await js(`(()=>{const sidebar=window.__dshSideChatTest.get('sidebarRight');sidebar.close(sidebar.active().id);})()`);
  await until(() => js(`!document.querySelector('[data-side-chat-session]')`), 'Ending side chat did not close its panel');
  assert.equal(await js(`window.__dshSideChatTest.get('sidebarRight').active().id`), originalTab.id);
  await until(() => report.sideStreamClosed, 'Ending side chat did not cancel its active stream');
  await until(() => js(`!window.__dshSideChatTest.sessions.list.getSnapshot().byId[${JSON.stringify(childId)}]`), 'The temporary side remains in the Session catalog after close');
  const archived = await js(`Array.from(window.__dshSideChatTest.get('workspaces').list.getSnapshot().archivedSessionIds)`);
  assert.ok(!archived.includes(childId)); assert.ok(!archived.includes(parentId));
  assert.equal(await running(parentId), true);
  assert.deepEqual(await entries(parentId), before);
  report.checks.push('Ending an active side cancels its stream and discards only the temporary branch without an archived record; parent keeps running');
  report.checks.push('The pre-existing native Files sidebar tab survives side-chat opening and closing, and becomes active again');
  await submit(parentId, '/side');
  const replacementId = await until(() => js(`document.querySelector('[data-side-chat-session]')?.getAttribute('data-side-chat-session')`), 'Side chat did not reopen');
  assert.notEqual(replacementId, childId);
  const replacementText = await js(`document.querySelector('[data-side-chat-session]').innerText`);
  assert.ok(!replacementText.includes('SIDE_CONTEXT_OK') && !replacementText.includes('CONTEXT_TOKEN_ALPHA') && !replacementText.includes('PARENT_RUNNING'));
  report.checks.push('Reopening creates a fresh empty side conversation instead of resuming the discarded history');
  report.reloaded = true;
  host.reload();
  await until(() => js('!!window.__dshSideChatTest'), 'The native frontend did not reload');
  await until(() => js(`!window.__dshSideChatTest.sessions.list.getSnapshot().byId[${JSON.stringify(replacementId)}]`), 'Leaving the page did not discard the temporary side');
  await until(() => running(parentId), 'The original turn did not survive leaving the side page');
  await until(() => js(`!document.querySelector('[data-side-chat-session]')`), 'A stale side panel survived the frontend reload');
  // RC.1 loads session state and the event log through independent streams.
  await until(async () => (await entries(parentId)).length >= before.length, 'The main event log did not finish loading after reload');
  assert.deepEqual(await entries(parentId), before);
  report.checks.push('Reloading the Desktop/Web frontend expires its temporary side while the original main turn continues');
  releaseParent();
  await until(async () => !(await running(parentId)), 'The original parent stream failed to complete');
  const finalParent = await entries(parentId);
  assert.ok(JSON.stringify(finalParent).includes('PARENT_FINISHED'));
  assert.ok(!JSON.stringify(finalParent).includes('SIDE_INLINE_QUESTION'));
  assert.ok(!JSON.stringify(finalParent).includes('SIDE_FOLLOWUP'));
  assert.ok(!JSON.stringify(finalParent).includes('SIDE_CONTEXT_OK'));
  assert.deepEqual(report.console, []);
  assert.deepEqual(JSON.parse(readFileSync(join(profile, 'local-plugins/package.json'), 'utf8')), { private: true });
  report.checks.push('Original turn completes with no side questions or replies in its durable history; anonymous local-plugin manifest remains correct');
  await submit(parentId, '/side');
  report.shutdownChildId = await until(() => js(`document.querySelector('[data-side-chat-session]')?.getAttribute('data-side-chat-session')`), 'The shutdown test side did not open');
}
mock.listen(0, '127.0.0.1', () => {
  writeFileSync(web ? join(profile, 'cordis.patch.yml') : join(home, 'desktop.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${mock.address().port}\n    apiKeyEnv: DSH_DESKTOP_FIXTURE_KEY\n    maxTokens: 4096\n- id: agent-preset-registry\n  config:\n    default: standard\n`);
  writeFileSync(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n');
  if (!web) {
    app.setAppPath(appRoot);
    require(join(appRoot, 'dist/main/index.cjs'));
    return;
  }
  const runtimeRoot = join(appRoot, '.runtime');
  webChild = spawn(join(runtimeRoot, 'bin/node'), [join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--port', '0', '--no-open'], { cwd: workspace, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [webChild.stdout, webChild.stderr]) stream.on('data', bytes => {
    const text = String(bytes);
    const url = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
    if (url) webUrl = url;
    webLog += text.replace(/token=[^\s&"']+/g, 'token=[redacted]');
  });
  webChild.once('error', finish);
  void (async () => {
    await until(() => webUrl, 'Native Web profile did not report its authenticated local URL', 45000);
    await app.whenReady();
    const window = new BrowserWindow({ width: 1360, height: 860, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadURL(webUrl);
    await run(window.webContents);
    await finish();
  })().catch(finish);
});
