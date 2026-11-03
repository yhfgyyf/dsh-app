// Exercise page injections through the production Host, IPC and Electron renderer.
const { app, ipcMain, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const childProcess = require('node:child_process');

const root = resolve(__dirname, '..');
const reports = join(root, '.test-data');
mkdirSync(reports, { recursive: true });
const data = mkdtempSync(join(reports, 'index-injections-'));
const home = join(data, 'core'), profile = join(home, 'profiles/desktop'), workspace = join(data, 'workspace');
const driver = join(profile, 'node_modules/dsh-index-injection-fixture');
mkdirSync(driver, { recursive: true });
mkdirSync(workspace);
const whale = process.env.DSH_TEST_WHALE_PACKAGE && resolve(process.env.DSH_TEST_WHALE_PACKAGE);
if (whale) cpSync(whale, join(profile, 'node_modules/dsh-whale-widget'), { recursive: true });
writeFileSync(join(driver, 'package.json'), JSON.stringify({ name: 'dsh-index-injection-fixture', version: '0.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }));
writeFileSync(join(driver, 'cordis.patch.yml'), '- insert:\n    - name: dsh-index-injection-fixture\n');
writeFileSync(join(driver, 'index.js'), `export const inject = ['webServer', 'connection'];
export function apply(ctx) {
  ctx.on('webserver/index-inject', (table, peer) => {
    if (peer !== ctx.connection.browserPeer) throw new Error('Incorrect Desktop injection peer');
    table.push(
    {kind:'global',name:'__dshInjectionProbe',value:{order:[]}},
    {kind:'script',placement:'head',text:'window.__dshInjectionProbe.order.push("inline")'},
    {kind:'style',text:'#dsh-injection-probe{color:rgb(1, 2, 3)}'},
    {kind:'html',placement:'body',html:'<span id="dsh-injection-probe" hidden>fixture</span>'},
    {kind:'script-preload',src:'/dsh-injection-fixture-must-not-execute.js'},
    {kind:'script-src',placement:'body',src:'/dsh-injection-fixture.js'}
    );
  });
  ctx.effect(() => ctx.webServer.register({kind:'exact',path:'/dsh-injection-fixture.js',handler(req,res){
    res.writeHead(200,{'content-type':'application/javascript'});
    res.end('window.__dshInjectionProbe.order.push(document.getElementById("dsh-injection-probe")?"external-after-html":"missing-html")');
  }}));
}`);
writeFileSync(join(driver, 'client.js'), `window.__ModuleLoader__.load({id:'dsh-index-injection-fixture',factory:()=>({inject:['sessions','uiWorkspace'],apply(ctx){window.__dshInjectionFixture=ctx;}})});`);
const manifest = { name: 'dsh-profile-desktop', private: true,
  dependencies: { 'dsh-index-injection-fixture': 'file:' + driver, ...whale ? { 'dsh-whale-widget': 'file:' + whale } : {} },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-desktop-surface', 'dsh-index-injection-fixture', ...whale ? ['dsh-whale-widget'] : []] } } };
writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest));
Object.assign(process.env, { DSH_DESKTOP_DATA_DIR: data, DSH_DESKTOP_CONFIG_HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' });
const report = { checks: [], failures: [], console: [], data, whale: whale ? JSON.parse(readFileSync(join(whale, 'package.json'))).version : null, readyCount: 0, coreStopped: false };
let corePid, host, finished = false, reloading = false;
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (String(args[1]?.[0]).replaceAll('\\', '/').endsWith('/app/index.ts')) corePid = child.pid;
  return child;
};
const clean = value => String(value).replace(/token=[^\s&"']+/g, 'token=[redacted]');
const handlers = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await fn()) return; await sleep(50); }
  throw new Error(label);
}
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  if (error) report.failures.push(clean(error.stack ?? error));
  app.quit();
}
const deadline = setTimeout(() => finish(new Error('Page injection integration timed out')), 70000);
process.on('exit', () => {
  try { process.kill(corePid, 0); } catch { report.coreStopped = true; }
  if (!report.coreStopped) report.failures.push('Owned fixture core survived shutdown');
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(reports, 'index-injections.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exit(1);
});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener);
  return handle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'desktop:ready') {
      reloading = false;
      report.readyCount++;
      host = args[0].sender;
      setImmediate(() => run(args[0]).catch(finish));
    }
    return result;
  });
};
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => {
    if (details.level !== 'error') return;
    const message = clean(details.message);
    if (reloading && message.startsWith('[cordis-client-runner] syncing inspect providers failed:')) return;
    report.console.push(message);
  });
  contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) report.failures.push(`${code}: ${description}`);
  });
});
async function run(event) {
  const js = source => host.executeJavaScript(source, true);
  const nativeWindow = BrowserWindow.fromWebContents(host);
  nativeWindow.setSize(1200, 850);
  host.setBackgroundThrottling(false);
  assert.deepEqual(await js('window.__dshInjectionProbe?.order'), ['inline', 'external-after-html'], 'Structured page injections never reached the Desktop page in order');
  assert.equal(await js('getComputedStyle(document.getElementById("dsh-injection-probe")).color'), 'rgb(1, 2, 3)');
  assert.equal(await js('typeof window.__dshInjectionFixture?.sessions'), 'object', 'Core module bootstrap was overwritten or repeated');
  report.checks.push(`Boot ${report.readyCount}: global, inline script, style, HTML and external script execute in order without replacing the module loader`);
  if (report.readyCount === 3) {
    assert.equal(await js('!!window.__dshWhaleWidget'), false);
    assert.equal(await js('document.querySelectorAll(".dshwv-root").length'), 0);
    report.checks.push('A fresh Host with Whale disabled starts normally without a stale widget injection');
    assert.deepEqual(report.console, []);
    return finish();
  }
  await js(`Array.from(document.querySelectorAll('button')).find(button=>['继续','Continue'].includes(button.textContent))?.click()`);
  await js(`Array.from(document.querySelectorAll('button')).find(button=>['稍后配置','Configure later'].includes(button.textContent))?.click()`);
  await js(`(async()=>{const ctx=window.__dshInjectionFixture;const id=await ctx.sessions.create({cwd:${JSON.stringify(workspace)}});ctx.uiWorkspace.openSession(id);})()`);
  await until(() => js('!!document.querySelector("[data-composer-input]")'), 'Fixture chat composer did not mount');
  if (whale) {
    await until(() => js('document.querySelectorAll(".dshwv-root").length===1'), 'The actual Whale package did not create its widget');
    await until(() => js('Array.from(document.querySelectorAll(".dshwv-root img")).some(img=>img.complete&&img.naturalWidth>0)'), 'Whale image did not load');
    report.checks.push(`Boot ${report.readyCount}: the unmodified Whale ${report.whale} package mounts one widget and loads its image`);
    const screenshot = await host.capturePage();
    writeFileSync(join(data, `whale-boot-${report.readyCount}.png`), screenshot.toPNG());
  }
  assert.deepEqual(report.console, []);
  if (report.readyCount === 1) {
    reloading = true;
    host.reload();
  } else if (whale) {
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-whale-widget');
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest));
    reloading = true;
    host.once('did-finish-load', () => setImmediate(() => handlers.get('desktop:reconnect')({ sender: host, senderFrame: host.mainFrame }).catch(finish)));
    process.kill(corePid, 'SIGTERM');
  } else finish();
}
app.setAppPath(root);
require('../dist/main/index.cjs');
