const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const root = join(__dirname, '..');
mkdirSync(join(root, '.test-data'), { recursive: true });
const data = mkdtempSync(join(root, '.test-data/remote-settings-'));
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
const relay = spawn(join(root, '.runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node'), ['services/relay/node_modules/tsx/dist/cli.mjs', 'services/relay/test/settings-fixture.ts'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
const fixture = new Promise((resolve, reject) => { createInterface({ input: relay.stdout }).once('line', line => resolve(JSON.parse(line))); relay.once('error', reject); });
const report = { checks: [], errors: [] };
let finished = false, started = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { for(let i=0;i<240;i++) {if(await check())return;await sleep(100);}throw new Error(message); }
const timer = setTimeout(() => finish(new Error('Remote settings timeout')), 90000);
function finish(error) { if(finished)return;finished=true;clearTimeout(timer);if(error)report.errors.push(String(error));writeFileSync(join(data,'result.json'),JSON.stringify(report,null,2));writeFileSync(join(root,'.test-data/remote-settings-latest.json'),JSON.stringify({platform:process.platform,...report},null,2));console.log(JSON.stringify({data,...report}));relay.stdin.end();app.quit(); }
app.on('quit',()=>{relay.stdin.end();if(report.errors.length)process.exit(1);});
const original = ipcMain.handle.bind(ipcMain);
const handlers = new Map();
ipcMain.handle=(channel,listener)=> {handlers.set(channel,listener);return original(channel,async (...args)=>{const result=await listener(...args);if(channel==='desktop:ready'&&!started){started=true;setTimeout(()=>run(args[0]).then(()=>finish()).catch(finish),100);}return result;});};
async function run(event) {
  const host = event.sender;

  const js = code => host.executeJavaScript(code, true);
  const finishOnboarding = () => until(() => js(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(b =>
      ['继续', 'Continue', '稍后配置', 'Configure later'].includes(b.textContent));
    if (button) {
      if (!button.disabled) button.click();
      return false;
    }
    return document.getElementById('root')?.inert === false
      && document.querySelector('[data-conversation-content][data-conversation-session]:not([data-conversation-session=""]) [contenteditable="true"][data-phase="plain"]') !== null
      && document.querySelector('button.VOzbGW_trigger, button[aria-label="账号菜单"], button[aria-label="Account menu"]') !== null;
  })()`), 'Onboarding did not release the Settings controls');
  // DSH 0.2 skips the web welcome notice when the native dshDesktop bridge is
  // present. Wait for usable Settings instead, still dismissing any optional
  // credential onboarding that the provider contributes.
  await finishOnboarding();
  // The account menu mounts before the initial session. Its later blank-session
  // onboarding transition can close Settings even when native onboarding renders
  // nothing. Wait for the live composer above and let that React commit finish.
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const openedDirectly = await js(`(() => {
    const trigger = document.querySelector('button.VOzbGW_trigger');
    if (trigger) { trigger.click(); return true; }
    document.querySelector('button[aria-label="账号菜单"], button[aria-label="Account menu"]').click();
    return false;
  })()`);
  if (!openedDirectly) await until(() => js(`(() => {
    const settings = Array.from(document.querySelectorAll('button[role="menuitem"]')).find(button =>
      Array.from(button.querySelectorAll('span')).some(span => ['设置', 'Settings'].includes(span.textContent)));
    if (!settings) return false;
    settings.click(); return true;
  })()`), 'Settings entry missing from the account menu');
  const selector = '.desktop-remote-settings [role="switch"]';
  await until(()=>js(`!!document.querySelector(${JSON.stringify(selector)})`),'Remote settings row missing');
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')`),'false');
  await js(`document.querySelector('.desktop-remote-settings button[aria-expanded]').click()`);
  await until(()=>js(`!!document.querySelector('.desktop-remote-panel input[type=url]')`),'Management panel missing');
  report.checks.push('Remote control appears inside Settings, defaults off and management fields expand');
  const f=await fixture;
  for(const invalid of [{...event,sender:{}},{...event,senderFrame:{url:'https://untrusted.invalid/'}}]) await assert.rejects(Promise.resolve().then(()=>handlers.get('desktop:remote-action')(invalid,{type:'pair'})));
  const act=action=>handlers.get('desktop:remote-action')(event,action);
  await act({type:'configure',config:{relay:f.relay,name:'Settings fixture',enabled:false,background:false,sessionOnly:true}});
  const registered=await act({type:'register',code:f.code});assert.equal(registered.registered,true);
  await act({type:'configure',config:{...registered.config,enabled:true}});
  await until(async()=> (await handlers.get('desktop:remote-state')(event)).status==='online','Relay did not connect');
  await js(`Array.from(document.querySelectorAll('.desktop-remote-panel button')).find(b=>b.textContent==='配对手机').click()`);
  await until(()=>js(`!!document.querySelector('.desktop-remote-pair img')`),'Pairing QR did not render');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(data, 'diagnostics.json') });
  await handlers.get('desktop:remote-diagnostics')(event);
  const diagnostics=JSON.parse(readFileSync(join(data,'diagnostics.json'),'utf8'));
  assert.equal(diagnostics.status,'online');
  assert.equal('pairing' in diagnostics,false); assert.equal('devices' in diagnostics,false);
  assert.equal(JSON.stringify(diagnostics).includes(f.code),false);
  report.checks.push('Diagnostic export contains state and counts, without QR, device credentials or account identities');
  const state=await handlers.get('desktop:remote-state')(event);
  assert.match(state.pairing.qr,/^data:image\/png;base64,/);
  assert.ok(state.pairing.expiresAt>Date.now());
  assert.equal('credentials' in state,false);
  report.checks.push('Private relay registration, outgoing connection and real QR rendering work; renderer state excludes persistent secrets');
  await js(`document.querySelector('.desktop-remote-pair').scrollIntoView({block:'center'})`);
  await act({type:'cancel-pair'});
  await until(()=>js(`!document.querySelector('.desktop-remote-pair img')`),'Cancelled QR remained visible');
  const background = await handlers.get('desktop:remote-state')(event);
  await act({type:'configure',config:{...background.config,background:true}});
  const nativeWindow = BrowserWindow.fromWebContents(host);
  nativeWindow.close();
  await until(()=>!nativeWindow.isVisible(),'Window did not hide to tray');
  assert.equal(nativeWindow.isDestroyed(),false);
  nativeWindow.show();
  report.checks.push('Opt-in background close hides to a working native tray and preserves the window');
  await act({type:'unregister'});
  assert.equal((await handlers.get('desktop:remote-state')(event)).registered,false);
  report.checks.push('Cancel removes QR; unregister drops pairing and remote identity; untrusted IPC is rejected');
}
app.setAppPath(root);
require(join(root,'dist/main/index.cjs'));
