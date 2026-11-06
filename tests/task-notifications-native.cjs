// The production Desktop/Host and a local model fixture; no user profile or API key.
const { app, BrowserWindow, ipcMain, Notification, nativeImage } = require('electron');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const childProcess = require('node:child_process');
const assert = require('node:assert/strict');
const root = join(__dirname, '..'), data = process.env.DSH_NOTIFICATION_TEST_DATA ?? join(root, '.test-data', 'task-notifications-' + Date.now());
app.setAppPath(root);
mkdirSync(join(data, 'core'), { recursive: true });
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
process.env.DSH_DESKTOP_NOTIFICATION_KEY = 'owned-local-fixture';
const report = { platform: process.platform, badgeBackend: process.platform === 'win32' ? 'BrowserWindow.setOverlayIcon' : process.platform === 'darwin' ? 'app.dock.setBadge' : 'LauncherEntry + window/tray icon', passed: false, checks: [], failures: [], badgeValues: [], notificationCalls: [], nativeShown: 0, nativeFailed: 0, nativeFailureReasons: [], modelRequests: 0 };
if (process.platform === 'win32') {
  const setOverlayIcon = BrowserWindow.prototype.setOverlayIcon;
  BrowserWindow.prototype.setOverlayIcon = function (image, description) {
    if (image) { assert.equal(image.isEmpty(), false); writeFileSync(join(data, 'native-overlay.png'), image.toPNG()); }
    report.badgeValues.push(image ? description.match(/^\d+/)[0] : '');
    return setOverlayIcon.call(this, image, description);
  };
} else if (process.platform === 'linux') {
  const setBadgeCount = app.setBadgeCount.bind(app);
  app.setBadgeCount = count => { report.badgeValues.push(count ? String(count) : ''); return setBadgeCount(count); };
}
const notices = [], handlers = new Map();
let corePid, finished = false, testing = false;
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  if (String(args[1]?.[0]).replaceAll('\\', '/').endsWith('/app/index.ts')) corePid = child.pid;
  return child;
};
const nativeShow = Notification.prototype.show;
Notification.prototype.show = function () {
  notices.push(this); report.notificationCalls.push({ title: this.title, body: this.body });
  this.once('show', () => { report.nativeShown++; writeFileSync(join(data, 'native-shown.json'), JSON.stringify({ shown: report.nativeShown, title: this.title })); });
  this.once('failed', (_event, error) => { report.nativeFailed++; report.nativeFailureReasons.push(String(error)); });
  return nativeShow.call(this);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(40); }
  throw new Error(label);
}
function badge() { return app.dock?.getBadge() ?? String(report.badgeValues.at(-1) ?? ''); }
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  if (req.url?.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })); return; }
  if (!req.url?.endsWith('/messages')) { res.writeHead(404); res.end('{}'); return; }
  const body = JSON.parse(raw), input = JSON.stringify(body.messages);
  report.modelRequests++;
  if (input.includes('NOTIFICATION_ERROR')) {
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Owned notification failure fixture' } })); return;
  }
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'owned-title', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'Owned task' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 4 } })); return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('message_start', { message: { id: randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 8, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Owned task completed.' } });
  if (input.includes('NOTIFICATION_SLOW')) return;
  setTimeout(() => {
    if (res.destroyed) return;
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
    emit('message_stop', {}); res.end();
  }, 80);
});
const mockReady = new Promise(resolve => mock.listen(0, '127.0.0.1', () => {
  writeFileSync(join(data, 'core/desktop.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${mock.address().port}\n    apiKeyEnv: DSH_DESKTOP_NOTIFICATION_KEY\n    maxTokens: 1024\n- id: agent-preset-registry\n  config: { default: standard }\n`);
  resolve();
}));
const whenReady = app.whenReady.bind(app);
app.whenReady = () => whenReady().then(async () => {
  await mockReady;
  if (app.dock && !app.dock.__notificationFixture) {
    app.dock.__notificationFixture = true;
    const setBadge = app.dock.setBadge.bind(app.dock);
    app.dock.setBadge = value => { report.badgeValues.push(value); setBadge(value); };
  }
});
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(watchdog);
  if (error) report.failures.push(String(error.stack ?? error).replace(/token=[^\s&"']+/g, 'token=[redacted]'));
  report.passed = report.failures.length === 0;
  mock.closeAllConnections(); mock.close(); app.quit();
}
process.on('exit', () => {
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ data, ...report }, null, 2));
  if (!report.passed) process.exitCode = 1;
});
const watchdog = setTimeout(() => finish(new Error('Native task notification acceptance timed out')), process.env.DSH_NOTIFICATION_REQUIRE_PRESENTATION ? 180000 : 90000);
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => {
  handlers.set(channel, fn);
  return handle(channel, async (...args) => {
    const result = await fn(...args);
    if (channel === 'desktop:ready' && !testing) {
      testing = true;
      setTimeout(() => run(args[0]).then(() => finish(), finish), 100);
    }
    return result;
  });
};
async function run(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const background = async () => {
    if (process.platform === 'darwin') win.hide(); else win.minimize();
    await until(() => !win.isFocused(), 'App did not enter the background');
  };
  const js = source => event.sender.executeJavaScript(source);
  const rpc = (method, args) => js(`(async () => {
    const response = await fetch('/api/' + ${JSON.stringify(method)}, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'client-request',rpcId:${JSON.stringify(randomUUID())},method:${JSON.stringify(method)},payload:{args:${JSON.stringify(args)}}}) });
    const result = (await response.json()).result; if (!result.ok) throw Error(JSON.stringify(result.error)); return result.value;
  })()`);
  const create = async title => {
    const sessionId = (await rpc('session/create', { request: { cwd: data, agentPreset: 'standard' } })).sessionId;
    await rpc('session/rename', { request: { sessionId, title } }); return sessionId;
  };
  const prompt = (id, text) => rpc('session/prompt', { request: { sessionId: id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } });
  const stopped = async id => until(async () => !(await rpc('session/list', { _request: {} })).items.find(s => s.sessionId === id)?.running, 'Session did not stop');
  assert.equal(handlers.has('desktop:notification-result'), false);
  await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:notification-view')({ ...event, sender: {} }, null)));
  await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:notification-view')(event, '../wrong')));
  report.checks.push('Task outcomes arrive only from the owned core; notification-view IPC rejects foreign senders and invalid ids');
  const completed = await create('Native completion'); await background();
  await prompt(completed, 'NOTIFICATION_COMPLETE');
  await until(() => notices.length === 1 && badge() === '1', 'Background completion notification/badge missing');
  assert.equal(notices[0].title, '任务已完成');
  assert.match(notices[0].body, /Native completion/);
  if (process.env.DSH_NOTIFICATION_REQUIRE_PRESENTATION) {
    for (let attempt = 0; attempt < 24 && report.nativeShown === 0; attempt++) { await sleep(5000); if (report.nativeShown === 0) nativeShow.call(notices[0]); }
    assert(report.nativeShown > 0, 'System notification presentation was not authorized');
    await sleep(Number(process.env.DSH_NOTIFICATION_PRESENTATION_PAUSE_MS ?? 0));
  }
  report.checks.push('A real streamed model turn completes in the owned Host and creates one native notification and platform badge 1');
  app.focus({ steal: true }); notices[0].emit('click');
  await until(async () => await js(`!!document.querySelector('[data-conversation-session="${completed}"] [contenteditable="true"]')`), 'Notification click did not navigate to its conversation');
  await until(() => badge() === '', 'Reading the notified conversation did not clear the badge');
  await until(() => win.isFocused(), 'App did not regain focus');
  const before = report.modelRequests;
  await prompt(completed, 'NOTIFICATION_FOREGROUND');
  await until(() => report.modelRequests > before, 'Foreground model request did not run'); await stopped(completed); await sleep(200);
  assert.equal(notices.length, 1);
  report.checks.push('Notification click uses the real workspace navigator and read clearing; a focused foreground completion stays quiet');
  const failed = await create('Native interrupted'); await background(); await prompt(failed, 'NOTIFICATION_ERROR');
  await until(() => notices.length === 2 && badge() === '1', 'Model failure notification missing');
  assert.equal(notices[1].title, '任务意外中断');
  assert(!notices[1].body.includes('invalid_request_error'));
  const slow = await create('Native deliberate stop'), requests = report.modelRequests;
  await prompt(slow, 'NOTIFICATION_SLOW'); await until(() => report.modelRequests > requests, 'Slow model did not start');
  await rpc('session/cancel', { request: { sessionId: slow } }); await stopped(slow); await sleep(200);
  assert.equal(notices.length, 2); assert.equal(badge(), '1');
  report.checks.push('An actual model failure alerts without error details; deliberate session cancellation creates no alert or unread count');
  const another = await create('Native unread second'); await prompt(another, 'NOTIFICATION_SECOND');
  await until(() => notices.length === 3 && badge() === '2', 'Second unread conversation did not produce badge 2');
  win.webContents.reload();
  await until(() => win.webContents.getURL().startsWith('http:') && !win.webContents.isLoading(), 'Renderer did not reload'); await sleep(500);
  assert.equal(notices.length, 3); assert.equal(badge(), '2');
  report.checks.push('Two unread sessions yield badge 2; renderer reload neither duplicates history alerts nor clears background reminders');
  const crash = await create('Native runtime failure'), count = report.modelRequests;
  await prompt(crash, 'NOTIFICATION_SLOW'); await until(() => report.modelRequests > count, 'Crash fixture turn did not start');
  process.kill(corePid, 'SIGKILL');
  await until(() => notices.length === 4 && badge() === '3', 'Core exit did not alert for its active task');
  assert.equal(notices[3].title, '任务意外中断');
  await until(() => win.webContents.getURL().startsWith('dsh:') && !win.webContents.isLoading(), 'Core recovery page did not settle');
  report.checks.push('Unexpected core termination reports its active task exactly once and retains earlier unread results');
  const overlay = nativeImage.createFromPath(join(data, 'badge-12.png'));
  assert.equal(overlay.isEmpty(), false); assert.deepEqual(overlay.getSize(), { width: 32, height: 32 });
  report.checks.push('Electron independently decodes the red Windows numeric-overlay image');
  report.systemPresentation = { dispatched: notices.length, shown: report.nativeShown, failed: report.nativeFailed, note: 'System presentation is separate from native dispatch and platform badge verification' };
}
require('../dist/main/index.cjs');
