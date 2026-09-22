// Load the original npm browser client through the production module loader.
// Only its host implementation is inert; no Office engine or online model runs.
const { app, ipcMain, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { zstdCompressSync } = require('node:zlib');

app.commandLine.appendSwitch('lang', 'en-US');
const root = join(__dirname, '..');
const reports = join(root, '.test-data', 'univer-client');
const data = join(reports, String(Date.now()));
const home = join(data, 'core');
const workspace = join(data, 'workspace');
const profile = join(home, 'profiles', 'desktop');
const bundle = join(profile, 'node_modules', 'dsh-univer-office');
const clientSha256 = 'df478f1ee572440e0b779728c9684b36c61809c36961e42d659a3486894b4ac7';
const clientBytes = 1101122;
const clientUrl = 'https://unpkg.com/dsh-univer-office@0.3.2/lib/client.js';
const sessionId = 'session-' + randomUUID();
const title = 'Univer ordinary conversation acceptance';
const reply = 'UNIVER_CLIENT_ORDINARY_TURN_RENDERED';
for (const directory of [bundle, workspace]) mkdirSync(directory, { recursive: true });
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = home;
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_DISABLED = '1';
const report = {
  status: 'running', checks: [], failures: [], console: [], expectedReloadMessages: [], externalRequests: [],
  clientSha256, clientBytes, platform: process.platform,
  scope: 'Original npm Univer 0.3.2 browser client startup, ordinary historical turn and reload; inert host, no Office engine or online model.',
  data, readyCount: 0,
};
const sanitize = text => String(text).replace(/token=[^\s&"']+/g, 'token=[redacted]');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let finished = false, started = false, failed = false, reloading = false, host;
const handlers = new Map();
const timeout = setTimeout(() => finish(new Error('Univer client startup regression timed out')), 110000);
async function until(fn, message, duration = 15000) {
  const start = Date.now();
  while (Date.now() - start < duration) { const value = await fn(); if (value) return value; await sleep(80); }
  throw new Error(message);
}
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) report.failures.push(sanitize(error.stack ?? error));
  failed = report.failures.length > 0;
  report.status = failed ? 'fail' : 'pass';
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(reports, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.quit();
}
app.on('quit', () => { if (failed) process.exit(1); });
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => {
    if (details.level !== 'error') return;
    const message = sanitize(details.message);
    if (reloading && message === '[cordis-client-runner] syncing inspect providers failed: Error: client api: dynamicCordisRunner/syncInspectManifest has no active Connection') {
      report.expectedReloadMessages.push(message);
      return;
    }
    report.console.push(message);
    if (!started) setImmediate(async () => {
      report.ui = await contents.executeJavaScript('document.body.innerText.slice(0, 4000)').catch(() => 'unavailable');
      const capture = await contents.capturePage().catch(() => null);
      if (capture) writeFileSync(join(data, 'startup-failure.png'), capture.toPNG());
      finish(new Error('Univer renderer startup failed: ' + message));
    });
  });
  contents.on('render-process-gone', (_event, details) => finish(new Error('Renderer exited: ' + details.reason)));
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) report.failures.push(`${code}: ${description} (${sanitize(url)})`);
  });
});
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener);
  return originalHandle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'desktop:ready') {
      report.readyCount++;
      reloading = false;
      if (!started) {
        started = true;
        host = args[0].sender;
        setTimeout(() => run(args[0]).then(() => finish()).catch(async error => {
          report.ui = await host.executeJavaScript('document.body.innerText.slice(0, 4000)').catch(() => 'unavailable');
          finish(error);
        }), 300);
      }
    }
    return result;
  });
};

async function run(event) {
  const window = BrowserWindow.fromWebContents(host);
  window.setSize(1100, 820);
  host.setBackgroundThrottling(false);
  window.show(); window.focus();
  const js = code => host.executeJavaScript(code, true);
  const graph = await handlers.get('desktop:boot')(event);
  assert.ok(graph.entries.some(entry => entry.id === 'dsh-univer-office'), 'Official boot graph omitted the real Univer client');
  const styles = () => js(`document.querySelectorAll('style[data-plugin="dsh-univer-office"]').length`);
  assert.equal(await styles(), 2, 'The original Univer client did not execute and install both stylesheets');
  report.checks.push('The production Desktop boots the SHA-pinned npm client through the real module loader, React and slot services');

  async function rpc(method, args) {
    return js(`(async()=>{const method=${JSON.stringify(method)};const body=await(await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:${JSON.stringify(args)}}})})).json();if(!body.result.ok)throw Error(JSON.stringify(body.result.error));return body.result.value;})()`);
  }
  async function openOrdinaryTurn() {
    await js(`Array.from(document.querySelectorAll('button')).find(b=>['继续','Continue'].includes(b.textContent))?.click()`);
    await sleep(300);
    await js(`Array.from(document.querySelectorAll('button')).find(b=>['稍后配置','Configure later'].includes(b.textContent))?.click()`);
    if (await js(`!!document.querySelector('[data-sidebar-collapsed]')`)) {
      host.send('desktop:command', 'sidebar');
      await until(() => js(`!document.querySelector('[data-sidebar-collapsed]')`), 'Sidebar did not expand');
    }
    await js(`document.querySelector('.YDXeBa_projectRow[aria-expanded="false"]')?.click()`);
    await until(() => js(`Array.from(document.querySelectorAll('.YDXeBa_sessionRow')).some(row=>row.textContent.includes(${JSON.stringify(title)}))`), 'Ordinary historical fixture session missing');
    await js(`Array.from(document.querySelectorAll('.YDXeBa_sessionRow')).find(row=>row.textContent.includes(${JSON.stringify(title)})).click()`);
    await until(() => js(`Array.from(document.querySelectorAll('.hWmORq_body')).some(element=>element.textContent.includes(${JSON.stringify(reply)}))`), 'Ordinary assistant turn did not render with the Univer client active');
    await sleep(300);
    assert.equal(await js(`document.querySelectorAll('.uvf_panel, .uvf_win').length`), 0, 'An ordinary turn created a spurious Univer preview');
    assert.deepEqual(report.console, [], 'Renderer console contains errors');
  }
  await rpc('workspace/create', { request: { path: workspace } });
  await rpc('session/rename', { request: { sessionId, title } });
  await openOrdinaryTurn();
  report.checks.push('A real historical ordinary chat turn renders without undefined matched data or a spurious Univer preview');
  const firstReady = report.readyCount;
  reloading = true;
  host.reload();
  await until(() => report.readyCount > firstReady, 'The production module loader did not become ready after reload', 25000);
  assert.equal(await styles(), 2, 'Reload duplicated or omitted Univer client styles');
  await openOrdinaryTurn();
  report.checks.push('Reload recreates the real loader and Univer registrations and renders the ordinary turn again without errors');
  assert.deepEqual(report.externalRequests, [], 'Renderer attempted external network access');
  assert.equal(readFileSync(join(data, 'blocked-fetches.jsonl'), 'utf8'), '', 'Host attempted external fetch');
  assert.deepEqual(report.console, [], 'Renderer console contains errors');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  report.screenshot = 'ready.png';
  writeFileSync(join(reports, report.screenshot), (await host.capturePage()).toPNG());
}

(async () => {
  let bytes;
  if (process.env.DSH_TEST_UNIVER_CLIENT) {
    report.clientSource = 'local SHA-pinned input';
    bytes = readFileSync(resolve(process.env.DSH_TEST_UNIVER_CLIENT));
  } else {
    report.clientSource = clientUrl;
    // Keep Electron before app.ready until production registers its protocols.
    // The separate bundled Node owns only this fixed, bounded download.
    bytes = execFileSync(join(root, '.runtime', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), ['--input-type=module', '-e',
      `const response=await fetch(${JSON.stringify(clientUrl)},{signal:AbortSignal.timeout(30000),redirect:'error'});if(response.status!==200)throw Error('Pinned npm client download failed: '+response.status);process.stdout.write(Buffer.from(await response.arrayBuffer()));`,
    ], { timeout: 35000, maxBuffer: clientBytes + 1, windowsHide: true });
  }
  assert.equal(bytes.length, clientBytes, 'Original npm Univer client byte count differs');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), clientSha256, 'Original npm Univer client SHA-256 differs');
  writeFileSync(join(bundle, 'client.js'), bytes);
  const requireRuntime = createRequire(join(root, '.runtime', 'package.json'));
  const schemaUrl = pathToFileURL(requireRuntime.resolve('@deepseek-ai/schemastery')).href;
  writeFileSync(join(bundle, 'index.mjs'), `import z from ${JSON.stringify(schemaUrl)};
export function apply(ctx) {
  ctx.inject(['settings'], scope => scope.settings.register('univer-office', z.object({autoOpenLivePreview:z.boolean().default(true)}), {base:{autoOpenLivePreview:true},applies:'live'}));
}
`);
  writeFileSync(join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: univer-client-fixture\n      name: dsh-univer-office\n');
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'dsh-univer-office', version: '0.3.2', type: 'module', main: './index.mjs',
    exports: { '.': './index.mjs', './client': { default: './client.js' }, './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: [
      '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
    ] } },
  }, null, 2));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true,
    dependencies: { 'dsh-univer-office': '0.3.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-desktop-surface', 'dsh-univer-office'] } },
  }, null, 2));
  const persistence = readFileSync(requireRuntime.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), 'utf8');
  const start = persistence.indexOf('function projectKey(cwd)');
  const end = persistence.indexOf('function projectDir(', start);
  assert.ok(start >= 0 && end > start, 'Pinned session persistence projectKey fixture anchor differs');
  const projectKey = new Function(persistence.slice(start, end) + ';return projectKey;')()(workspace);
  const sessionDir = join(home, 'sessions', projectKey, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  let seq = 0;
  const event = (type, value, surface = false) => ({ type, seq: seq++, time: Date.now(), data: value, ...(surface ? { surfaceOp: 'append' } : {}) });
  const rows = [
    { type: 'session', version: 3, id: sessionId, createdAt: Date.now(), cwd: workspace, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
    event('session/title', { title, messageSeqs: [], source: { kind: 'user' } }),
    event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }),
    event('user/message', { role: 'user', id: randomUUID(), source: { kind: 'user' }, content: [{ type: 'text', text: 'Show an ordinary reply without Office tools.' }] }, true),
    event('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, message: { role: 'assistant', id: randomUUID(), source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: reply }] } }, true),
    event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), Buffer.concat(rows.map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n')))));
  const blocked = join(data, 'blocked-fetches.jsonl');
  writeFileSync(blocked, '');
  const preload = join(data, 'block-external-fetch.cjs');
  writeFileSync(preload, `const original=globalThis.fetch;
globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){require('node:fs').appendFileSync(${JSON.stringify(blocked)},JSON.stringify({origin:url.origin})+'\\n');throw Error('Univer client fixture blocked external fetch: '+url.origin);}return original(input,options);};
`);
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  app.whenReady().then(() => session.fromPartition('persist:dsh').webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const url = new URL(details.url);
      const external = !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (external) report.externalRequests.push(url.origin);
      callback({ cancel: external });
    },
  ));
  app.setAppPath(root);
  require('../dist/main/index.cjs');
})().catch(finish);
