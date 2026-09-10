// Exercise the production Electron window, preload and DSH sidebar without a model request.
const { app, ipcMain, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { zstdCompressSync } = require('node:zlib');
const root = join(__dirname, '..');
const reports = join(root, '.test-data', 'sidebar-browser-native');
const data = join(reports, String(Date.now()));
mkdirSync(data, { recursive: true });
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
const workspace = join(data, 'workspace');
const sessionId = 'session-' + randomUUID();
mkdirSync(workspace, { recursive: true });
const persistence = readFileSync(join(root, '.runtime/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'), 'utf8');
const start = persistence.indexOf('function projectKey(cwd)'), end = persistence.indexOf('function projectDir(', start);
assert.ok(start >= 0 && end > start);
const projectKey = new Function(persistence.slice(start, end) + '; return projectKey;')()(workspace);
const sessionDirectory = join(data, 'core/sessions', projectKey, sessionId);
mkdirSync(sessionDirectory, { recursive: true });
let seq = 0;
const event = (type, data, surface = false) => ({ type, seq: seq++, time: Date.now(), data, ...(surface ? { surfaceOp: 'append' } : {}) });
const history = [
  { type: 'session', version: 3, id: sessionId, createdAt: Date.now(), cwd: workspace, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
  event('session/title', { title: 'Sidebar native acceptance', messageSeqs: [], source: { kind: 'user' } }),
  event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }),
  event('user/message', { role: 'user', id: randomUUID(), source: { kind: 'user' }, content: [{ type: 'text', text: 'Preview the local and remote documents.' }] }, true),
  event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
];
writeFileSync(join(sessionDirectory, 'session.v3.jsonl.zstd'), Buffer.concat(history.map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n')))));
const report = { checks: [], failures: [], console: [] };
const handlers = new Map();
let finished = false;
let failureCode = 0;
const timeout = setTimeout(() => finish(new Error('Sidebar integration timeout')), 55000);
const server = createServer((request, response) => {
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  response.setHeader('Content-Type', 'text/html');
  response.end(`<title>${request.url === '/second' ? 'Second page' : 'Sidebar fixture'}</title><h1>Sidebar fixture</h1><canvas id="chart" width="20" height="20"></canvas><script>chart.getContext('2d').fillRect(0,0,20,20)</script><a href="/second">Next</a>`);
});
server.listen(0, '127.0.0.1');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 12000) { const result = await fn(); if (result) return result; await sleep(60); }
  throw new Error(label);
}
function finish(error) {
  if (finished) return;
  finished = true;
  if (error) report.failures.push(String(error.stack ?? error).replace(/token=[^\s&"']+/g, 'token=[redacted]'));
  if (error) failureCode = 1;
  clearTimeout(timeout);
  server.close();
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(reports, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.quit();
}
app.on('quit', () => { if (failureCode) process.exit(failureCode); });
app.on('web-contents-created', (_event, contents) => contents.on('console-message', details => {
  if (details.level === 'error') report.console.push(String(details.message).replace(/token=[^\s&"']+/g, 'token=[redacted]'));
}));
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener);
  return originalHandle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'desktop:ready') setTimeout(() => run(args[0]).then(() => finish()).catch(async error => {
      report.ui = await args[0].sender.executeJavaScript(`({text:document.body.innerText.slice(0,2500),width:innerWidth,collapsed:!!document.querySelector('[data-sidebar-collapsed]'),buttons:Array.from(document.querySelectorAll('button')).map(b=>b.getAttribute('aria-label')||b.title||b.textContent).filter(Boolean).slice(0,25)})`).catch(() => null);
      finish(error);
    }), 300);
    return result;
  });
};
async function run(event) {
  const host = event.sender;
  const window = BrowserWindow.fromWebContents(host);
  window.setSize(980, 720);
  const invoke = (channel, ...args) => handlers.get('desktop:' + channel)({ sender: host, senderFrame: host.mainFrame }, ...args);
  const url = `http://127.0.0.1:${server.address().port}/`;
  await host.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>['继续','Continue'].includes(b.textContent))?.click()`);
  await host.executeJavaScript(`(async()=>{
    const rpc=async(method,args)=>{const body=await (await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}})})).json();if(!body.result.ok)throw Error(JSON.stringify(body.result.error));return body.result.value;};
    await rpc('workspace/create',{request:{path:${JSON.stringify(workspace)}}});
    await rpc('session/rename',{request:{sessionId:${JSON.stringify(sessionId)},title:'Sidebar native acceptance'}});
  })()`);
  await sleep(500);
  await host.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>['稍后配置','Configure later'].includes(b.textContent))?.click()`);
  if (await host.executeJavaScript(`!!document.querySelector('[data-sidebar-collapsed]')`)) {
    host.send('desktop:command', 'sidebar');
    await until(() => host.executeJavaScript(`!document.querySelector('[data-sidebar-collapsed]')`), 'Sidebar did not expand in the narrow test window');
  }
  await host.executeJavaScript(`document.querySelector('.YDXeBa_projectRow[aria-expanded="false"]')?.click()`);
  await until(() => host.executeJavaScript(`Array.from(document.querySelectorAll('.YDXeBa_sessionRow')).some(row=>row.textContent.includes('Sidebar native acceptance'))`), 'Created fixture session missing from the sidebar');
  await host.executeJavaScript(`Array.from(document.querySelectorAll('.YDXeBa_sessionRow')).find(row=>row.textContent.includes('Sidebar native acceptance')).click()`);
  await until(() => host.executeJavaScript(`document.title.includes('Sidebar native acceptance')`), 'Fixture session missing');
  await sleep(400);
  await host.executeJavaScript(`{ const a = document.createElement('a'); a.href=${JSON.stringify(url)}; a.target='_blank'; document.body.append(a); a.click(); a.remove(); }`);
  await until(() => host.executeJavaScript(`!!document.querySelector('.desktop-browser')`), 'Link did not open the production sidebar');
  const page = await until(() => webContents.getAllWebContents().find(contents => contents !== host && contents.getURL() === url), 'No native sidebar view');
  await until(() => page.getTitle() === 'Sidebar fixture' && !page.isLoading(), 'Fixture did not load');
  const nativeView = window.contentView.children.find(view => view.webContents === page);
  await until(() => nativeView.getVisible() && nativeView.getBounds().width > 100, 'Native view not visible inside sidebar');
  await sleep(400); // Allow the sidebar's opening transition to settle.
  const rect = await host.executeJavaScript(`(() => {const r=document.querySelector('.desktop-browser-viewport').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
  assert.equal(nativeView.getBounds().x, Math.round(rect.x * host.getZoomFactor()));
  assert.equal(nativeView.getBounds().width, Math.round(rect.width * host.getZoomFactor()));
  report.checks.push('Clicking a link opens a visible native browser inside the actual DSH right sidebar, including X-Frame-Options DENY pages');
  const safety = await page.executeJavaScript(`({node:typeof require,preload:typeof window.dshDesktop,pixel:chart.getContext('2d').getImageData(0,0,1,1).data[3]})`);
  assert.deepEqual(safety, { node: 'undefined', preload: 'undefined', pixel: 255 });
  assert.notEqual(page.session, host.session);
  report.checks.push('Remote page runs Canvas with no Node or DSH preload and a separate cookie session');
  await host.executeJavaScript(`document.querySelector('.desktop-computer summary').click()`);
  assert.equal(await host.executeJavaScript(`(() => {
    const popup = document.querySelector('.desktop-computer-popover').getBoundingClientRect();
    const viewport = document.querySelector('.desktop-browser-viewport').getBoundingClientRect();
    return document.querySelector('.desktop-computer details').open && popup.height > 0 && popup.bottom <= viewport.top;
  })()`), true, 'The actual computer popover should sit above the preview');
  await sleep(250);
  assert.equal(nativeView.getVisible(), true, 'Computer popover outside the preview hid the native page');
  await host.executeJavaScript(`document.querySelector('.desktop-computer summary').click()`);
  report.checks.push('Opening the actual computer popover above the preview keeps the native page visible');
  await host.executeJavaScript(`{
    const rect = document.querySelector('.desktop-browser-viewport').getBoundingClientRect();
    const dialog=document.createElement('div');dialog.id='test-modal';dialog.role='dialog';dialog.textContent='Modal';
    Object.assign(dialog.style, {position:'fixed', left:rect.x + 20 + 'px', top:rect.y + 20 + 'px', width:'120px', height:'80px', zIndex:'9999'});
    document.body.append(dialog);
  }`);
  await until(() => !nativeView.getVisible(), 'Native view covered a modal');
  await host.executeJavaScript(`document.getElementById('test-modal').remove()`);
  await until(() => nativeView.getVisible(), 'Native view failed to return after modal');
  report.checks.push('Native page hides behind dialogs and returns after dismissal');
  await page.executeJavaScript(`document.querySelector('a').click()`, true);
  await until(() => page.getTitle() === 'Second page' && !page.isLoading(), 'Navigation failed');
  await until(() => host.executeJavaScript(`!document.querySelector('.desktop-browser button[aria-label="后退"]').disabled`), 'Back button remained disabled');
  await host.executeJavaScript(`document.querySelector('button[aria-label="后退"]').click()`);
  await until(() => page.getTitle() === 'Sidebar fixture' && !page.isLoading(), 'Back failed');
  await until(() => host.executeJavaScript(`!document.querySelector('.desktop-browser button[aria-label="前进"]').disabled`), 'Forward button remained disabled');
  await host.executeJavaScript(`document.querySelector('button[aria-label="前进"]').click()`);
  await until(() => page.getTitle() === 'Second page', 'Forward failed');
  report.checks.push('Sidebar toolbar back and forward follow native page history');
  writeFileSync(join(workspace, 'canvas.html'), '<title>Loading</title><canvas id="chart" width="10" height="10"></canvas><script src="canvas.js"></script>');
  writeFileSync(join(workspace, 'canvas.js'), 'chart.getContext("2d").fillRect(0,0,10,10);document.title="Local Canvas";');
  const target = { kind: 'preview', sessionId: 'fixture', cwd: workspace, address: 'dsh-resource://file/session/fixture/canvas.html' };
  await invoke('browser-open', 'fixture:preview', target, '1');
  const preview = await until(() => webContents.getAllWebContents().find(contents => contents.getTitle() === 'Local Canvas'), 'HTML preview or relative script failed');
  assert.equal(await preview.executeJavaScript(`chart.getContext('2d').getImageData(0,0,1,1).data[3]`), 255);
  assert.equal(await preview.executeJavaScript(`typeof require+':'+typeof window.dshDesktop`), 'undefined:undefined');
  const info = await invoke('info');
  assert.equal(await preview.executeJavaScript(`fetch(${JSON.stringify(info.endpoint + '/')}).then(()=>false,()=>true)`), true);
  report.checks.push('Local HTML Canvas executes relative JS while DSH core requests remain blocked');
  await invoke('browser-close', 'fixture:preview');
  await until(() => preview.isDestroyed(), 'Closed preview retained its renderer');
  report.checks.push('Closing preview releases its web contents');
  // rc.1 creates the guide through the pane's New tab control.
  await until(() => host.executeJavaScript(`!!document.querySelector('[data-sidebar-right-open] [data-dockkit-add-tab]')`), 'Sidebar New tab control missing');
  await host.executeJavaScript(`document.querySelector('[data-sidebar-right-open] [data-dockkit-add-tab]').click()`);
  await until(() => host.executeJavaScript(`!!document.querySelector('[data-sidebar-right-guide-entry="files"]')`), 'Files guide missing');
  await host.executeJavaScript(`document.querySelector('[data-sidebar-right-guide-entry="files"]').click()`);
  await until(() => host.executeJavaScript(`!!document.querySelector('[data-files-path$="/canvas.html"] button, [data-files-path="canvas.html"] button')`), 'Canvas missing from files sidebar');
  await host.executeJavaScript(`document.querySelector('[data-files-path$="/canvas.html"] button, [data-files-path="canvas.html"] button').click()`);
  const routed = await until(() => webContents.getAllWebContents().find(contents => contents.getTitle() === 'Local Canvas'), 'File click did not route to rendered preview');
  const routedView = window.contentView.children.find(view => view.webContents === routed);
  await until(() => routedView.getVisible() && !nativeView.getVisible(), 'File preview not visible or old web page remained above it');
  const previewTab = await host.executeJavaScript(`document.querySelector('[data-dockkit-tab][aria-selected="true"]')?.getAttribute('data-dockkit-tab')`);
  assert.ok(previewTab, 'The selected preview must be a sidebar content tab');
  await host.executeJavaScript(`Array.from(document.querySelectorAll('.desktop-browser button')).find(b=>b.textContent==='源码').click()`);
  await until(() => !routedView.getVisible() && host.executeJavaScript(`document.body.innerText.includes('canvas.js')`), 'Source view did not replace rendered content');
  await host.executeJavaScript(`document.querySelector('[data-dockkit-tab="${previewTab}"]').click()`);
  await until(() => routedView.getVisible(), 'Returning to preview lost its renderer');
  await host.executeJavaScript(`document.querySelector('[data-dockkit-tab-close="${previewTab}"]').click()`);
  await until(() => routed.isDestroyed(), 'Closing the actual DSH tab leaked its native renderer');
  report.checks.push('Actual files sidebar routes HTML to Canvas preview, switches to source, restores preview, and releases the renderer on tab close');
  const pending = invoke('browser-open', 'fixture:cancel', target, '2');
  await invoke('browser-close', 'fixture:cancel');
  await assert.rejects(pending, /此页面无法打开/);
  assert.equal(webContents.getAllWebContents().some(contents => contents.getURL().startsWith('dsh-preview:')), false);
  report.checks.push('Closing a preview during asynchronous file resolution cancels it without creating a stray view');
}
app.setAppPath(root);
require('../dist/main/index.cjs');
