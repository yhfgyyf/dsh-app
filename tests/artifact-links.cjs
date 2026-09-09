// Replay a historical, model-free session through the actual desktop UI.
const { app, ipcMain, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { zstdCompressSync } = require('node:zlib');
const root = join(__dirname, '..');
const data = join(root, '.test-data', 'artifact-links-native', String(Date.now()));
const home = join(data, 'core');
const workspace = join(data, 'workspace');
const sessionId = 'session-' + randomUUID();
// Use the pinned persistence implementation for Windows drive letters and separators too.
const persistence = readFileSync(join(root, '.runtime/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'), 'utf8');
const projectKeyStart = persistence.indexOf('function projectKey(cwd)');
const projectKeyEnd = persistence.indexOf('function projectDir(', projectKeyStart);
assert.ok(projectKeyStart >= 0 && projectKeyEnd > projectKeyStart);
const projectKey = new Function(persistence.slice(projectKeyStart, projectKeyEnd) + '; return projectKey;')()(workspace);
const sessionDir = join(home, 'sessions', projectKey, sessionId);
mkdirSync(workspace, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = home;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Artifact SVG</title><circle cx="50" cy="50" r="35" fill="red"><animate attributeName="r" values="30;35;30" dur="2s" repeatCount="indefinite"/></circle></svg>';
writeFileSync(join(workspace, 'pelican.svg'), svg);
writeFileSync(join(workspace, 'report.md'), '# Artifact report\n\nReadable report content.');
writeFileSync(join(workspace, 'my image.svg'), svg);
writeFileSync(join(workspace, 'canvas.html'), '<title>Artifact Canvas</title><canvas id="chart" width="10" height="10"></canvas><script>chart.getContext("2d").fillRect(0,0,10,10)</script>');
const text = [
  '**文件：** `pelican.svg`',
  '图片路径：`' + join(workspace, 'preview.png') + '`',
  '报告：`report.md`；不存在的文件：`missing.png`；普通代码：`viewBox`。',
  '[HTML Canvas](canvas.html) · [带空格图片](my%20image.svg)',
  '![Inline SVG](pelican.svg)',
  '[![Linked SVG](my%20image.svg)](my%20image.svg)',
  '[文档引用][report]\n\n[report]: report.md',
  '```svg\n' + svg + '\n```',
  '```text\nmissing-fenced.png\n```',
].join('\n\n');
const header = { type: 'session', version: 3, id: sessionId, createdAt: Date.now(), cwd: workspace, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
let seq = 0;
const event = (type, data, surface = false) => ({ type, seq: seq++, time: Date.now(), data, ...(surface ? { surfaceOp: 'append' } : {}) });
const rows = [header,
  event('session/title', { title: 'Artifact link acceptance', messageSeqs: [], source: { kind: 'user' } }),
  event('turn/start', { turn: 1 }),
  event('step/start', { turn: 1, step: 1 }),
  event('user/message', { role: 'user', id: randomUUID(), source: { kind: 'user' }, content: [{ type: 'text', text: 'Show the generated files.' }] }, true),
  event('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, message: { role: 'assistant', id: randomUUID(), source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text }] } }, true),
  event('step/end', { turn: 1, step: 1 }),
  event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
];
const log = join(sessionDir, 'session.v3.jsonl.zstd');
const original = Buffer.concat(rows.map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n'))));
writeFileSync(log, original);
const report = { data, checks: [], failures: [], console: [], headPaths: [] };
let finished = false;
let failure = false;
const timeout = setTimeout(() => finish(new Error('Artifact UI acceptance timed out')), 55000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const started = Date.now();
  while (Date.now() - started < 12000) { const result = await fn(); if (result) return result; await sleep(70); }
  throw new Error(label);
}
function finish(error) {
  if (finished) return;
  finished = true;
  failure = !!error;
  if (error) report.failures.push(String(error.stack ?? error).replace(/token=[^\s&"']+/g, 'token=[redacted]'));
  clearTimeout(timeout);
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(root, '.test-data', 'artifact-links-native', 'latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.quit();
}
app.on('quit', () => { if (failure) process.exit(1); });
app.on('web-contents-created', (_event, contents) => contents.on('console-message', details => {
  if (details.level === 'error') report.console.push(String(details.message).replace(/token=[^\s&"']+/g, 'token=[redacted]'));
}));
const originalHandle = ipcMain.handle.bind(ipcMain);
let started = false;
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
  const result = await listener(...args);
  if (channel === 'desktop:ready' && !started) {
    started = true;
    setTimeout(() => run(args[0]).then(() => finish()).catch(async error => {
      report.ui = await args[0].sender.executeJavaScript('document.body.innerText.slice(0, 3000)').catch(() => 'unavailable');
      report.layout = await args[0].sender.executeJavaScript(`({width:innerWidth,collapsed:!!document.querySelector('[data-sidebar-collapsed]'),buttons:Array.from(document.querySelectorAll('button')).map(b=>b.getAttribute('aria-label')||b.title||b.textContent).filter(Boolean).slice(0,25)})`).catch(() => null);
      finish(error);
    }), 300);
  }
  return result;
});
async function run(event) {
  const host = event.sender;
  const window = BrowserWindow.fromWebContents(host);
  window.setSize(980, 720);
  const js = code => host.executeJavaScript(code, true);
  await js(`Array.from(document.querySelectorAll('button')).find(b=>['继续','Continue'].includes(b.textContent))?.click()`);
  await js(`(async()=>{const method='workspace/create';const body=await(await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{request:{path:${JSON.stringify(workspace)}}}}})})).json();if(!body.result.ok)throw Error(JSON.stringify(body.result.error));})()`);
  await js(`(async()=>{const method='session/rename';const body=await(await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{request:{sessionId:${JSON.stringify(sessionId)},title:'Artifact link acceptance'}}}})})).json();if(!body.result.ok)throw Error(JSON.stringify(body.result.error));})()`);
  await sleep(500);
  await js(`Array.from(document.querySelectorAll('button')).find(b=>['稍后配置','Configure later'].includes(b.textContent))?.click()`);
  if (await js(`!!document.querySelector('[data-sidebar-collapsed]')`)) {
    host.send('desktop:command', 'sidebar');
    await until(() => js(`!document.querySelector('[data-sidebar-collapsed]')`), 'Sidebar did not expand in the narrow test window');
  }
  await js(`document.querySelector('.YDXeBa_projectRow[aria-expanded="false"]')?.click()`);
  await until(() => js(`Array.from(document.querySelectorAll('.YDXeBa_sessionRow')).some(row=>row.textContent.includes('Artifact link acceptance'))`), 'Historical fixture session missing');
  await js(`Array.from(document.querySelectorAll('.YDXeBa_sessionRow')).find(row=>row.textContent.includes('Artifact link acceptance')).click()`);
  await until(() => js(`!!document.querySelector('.hWmORq_body code button[title$="/pelican.svg"]')`), 'Bare SVG filename did not become a file link');
  const titles = await js(`Array.from(document.querySelectorAll('.hWmORq_body button[title]')).map(b=>b.title)`);
  for (const name of ['pelican.svg', 'preview.png', 'report.md', 'canvas.html', 'my image.svg']) assert.ok(titles.includes(join(workspace, name).replaceAll('\\', '/')), name);
  assert.equal(titles.some(path => path.endsWith('missing.png') || path.endsWith('missing-fenced.png')), false);
  assert.equal(await js(`!!document.querySelector('.hWmORq_body pre button[title]')`), false);
  assert.equal(await js(`!!document.querySelector('.hWmORq_body button button')`), false);
  report.checks.push('Historical reply links relative/absolute files, encoded filenames and Markdown references; missing paths and fenced code stay inert');
  await until(() => js(`!!document.querySelector('.desktop-artifact-previews button[title$="/preview.png"] img')?.naturalWidth`), 'PNG preview card missing or image failed to load');
  assert.equal(await js(`document.querySelectorAll('.desktop-artifact-previews button[title$="/pelican.svg"]').length`), 0);
  report.checks.push('Plain image path gains a loaded thumbnail; authored inline images avoid duplicate preview cards');
  const opened = async (selector, marker) => {
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const contents = await until(() => webContents.getAllWebContents().find(c => c !== host && c.getURL().startsWith('dsh-preview:') && c.getURL().endsWith(marker)), 'Sidebar preview missing: ' + marker);
    await until(() => { const view = window.contentView.children.find(view => view.webContents === contents); return view?.getVisible() && !contents.isLoading(); }, 'Sidebar preview invisible: ' + marker);
    return contents;
  };
  const svgPage = await opened('.hWmORq_body .desktop-file-image[title$="/pelican.svg"]', 'pelican.svg');
  assert.equal(await svgPage.executeJavaScript(`document.documentElement.localName`), 'svg');
  assert.equal(await svgPage.executeJavaScript(`document.querySelector('animate').getAttribute('dur')`), '2s');
  report.checks.push('Clicking the actual inline SVG opens its animated document in the native right sidebar');
  const pngPage = await opened('.desktop-artifact-previews button[title$="/preview.png"]', 'preview.png');
  assert.equal(await pngPage.executeJavaScript(`document.querySelector('img').naturalWidth`), 32);
  report.checks.push('Clicking the generated PNG thumbnail opens the full image in the right sidebar');
  const canvasPage = await opened('.hWmORq_body button[title$="/canvas.html"]', 'canvas.html');
  assert.equal(await canvasPage.executeJavaScript(`chart.getContext('2d').getImageData(0,0,1,1).data[3]`), 255);
  report.checks.push('Authored relative HTML link opens the working Canvas preview');
  await js(`document.querySelector('.hWmORq_body code button[title$="/report.md"]').click()`);
  await until(() => js(`document.body.innerText.includes('Readable report content.')`), 'Markdown document did not open in text sidebar');
  report.checks.push('Other generated documents use the existing sidebar text viewer');
  // Closing content leaves the seeded Start tab, but must release the column.
  await js(`Array.from(document.querySelectorAll('[data-dockkit-tab]')).filter(t=>!/^(开始|Start)/.test(t.textContent)).forEach(t=>document.querySelector('[data-dockkit-tab-close="'+t.getAttribute('data-dockkit-tab')+'"]').click())`);
  await until(() => js(`!document.querySelector('[data-sidebar-right-open]')`), 'Closing the last document left the sidebar open');
  await until(() => svgPage.isDestroyed() && pngPage.isDestroyed() && canvasPage.isDestroyed(), 'Closed sidebar retained native previews');
  const reopened = await opened('.hWmORq_body .desktop-file-image[title$="/pelican.svg"]', 'pelican.svg');
  assert.equal(await js(`!!document.querySelector('[data-sidebar-right-open]')`), true);
  await js(`{const guide=Array.from(document.querySelectorAll('[data-dockkit-tab]')).find(t=>/^(开始|Start)/.test(t.textContent));document.querySelector('[data-dockkit-tab-close="'+guide.getAttribute('data-dockkit-tab')+'"]').click()}`);
  assert.equal(await js(`!!document.querySelector('[data-sidebar-right-open]')`), true);
  await js(`document.querySelector('[data-dockkit-tab-close]').click()`);
  await until(() => reopened.isDestroyed() && js(`!document.querySelector('[data-sidebar-right-open]')`), 'Closing the sole preview failed to collapse');
  report.checks.push('Closing all documents or the sole preview collapses the sidebar, releases native views, and file links reopen it');
  // Restoring the UI must derive links from the unchanged retained messages.
  await host.reload();
  await until(() => js(`!!document.querySelector('.hWmORq_body code button[title$="/pelican.svg"]')`), 'Links missing after reload');
  assert.equal(createHash('sha256').update(readFileSync(log).subarray(0, original.length)).digest('hex'), createHash('sha256').update(original).digest('hex'));
  report.checks.push('Reload restores links and preserves every original session-log byte');
}
// Electron's CommonJS runtime cannot strip TypeScript, so generate the PNG
// with the same source helper using the bundled Node before booting the app.
const { execFileSync } = require('node:child_process');
execFileSync(join(root, '.runtime/bin/node'), ['--input-type=module', '-e', `import {pngFixture} from ${JSON.stringify('file://' + join(root, 'tests/png-fixture.ts'))};import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(workspace, 'preview.png'))},pngFixture());`]);
app.setAppPath(root);
require('../dist/main/index.cjs');
