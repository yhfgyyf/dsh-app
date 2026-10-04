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
  await until(()=>js(`!!document.querySelector('.desktop-general-settings')`),'General Settings missing');
  assert.equal(await js(`!!document.querySelector('.desktop-remote-settings')`),false);
  await js(`(() => {const dialog=document.querySelector('.desktop-general-settings').closest('[role="dialog"]');Array.from(dialog.querySelectorAll('button')).find(b=>['关闭','关闭设置','Close','Close settings'].includes(b.getAttribute('aria-label')??b.textContent.trim())).click();})()`);
  const click = text => js(`(() => {const b=Array.from(document.querySelectorAll('button')).find(b=>${JSON.stringify([text].flat())}.includes(b.textContent.trim()));if(!b||b.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});b.click();})()`);
  const fill = (selector,value) => js(`(async()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>requestAnimationFrame(r));})()`);
  await click(['插件','Plugins']);
  await until(()=>js(`!!document.querySelector('[data-plugin-package="dsh-p2p-collab"] button')`),'Collaboration plugin missing');
  await js(`document.querySelector('[data-plugin-package="dsh-p2p-collab"] button').click()`);
  await until(()=>js(`!!document.querySelector('[data-plugin-detail="dsh-p2p-collab"] .desktop-remote-panel input[type=url]')`),'Plugin configuration missing while disabled');
  assert.equal(await js(`document.querySelector('[data-plugin-detail="dsh-p2p-collab"] > div [role="switch"]').getAttribute('aria-checked')`),'false');
  assert.equal(await js(`document.querySelector('.desktop-remote-settings [role="switch"]').getAttribute('aria-checked')`),'false');
  const switches=await js(`Array.from(document.querySelectorAll('[data-plugin-detail="dsh-p2p-collab"] [role="switch"]')).map(el=>{const s=getComputedStyle(el);return [s.width,s.height,s.padding,s.borderRadius];})`);
  assert.equal(switches.length,2); assert.deepEqual(switches[1],switches[0]);
  assert.equal(await js(`document.body.innerText.includes('关闭窗口后继续在后台运行；从应用菜单退出后停止连接。')`),false);
  assert.equal(await js(`document.querySelectorAll('.desktop-remote-panel input[type=checkbox]').length`),0);
  assert.equal(await js(`document.querySelector('.desktop-remote-panel').scrollWidth>document.querySelector('.desktop-remote-panel').clientWidth`),false);
  report.checks.push('Remote settings moved from General Settings into the disabled collaboration plugin detail; relay fields are visible, remote control defaults off and obsolete copy is absent');
  writeFileSync(join(data,'plugin-unregistered.png'),(await host.capturePage()).toPNG());
  const f=await fixture;
  for(const invalid of [{...event,sender:{}},{...event,senderFrame:{url:'https://untrusted.invalid/'}}]) await assert.rejects(Promise.resolve().then(()=>handlers.get('desktop:remote-action')(invalid,{type:'pair'})));
  const act=action=>handlers.get('desktop:remote-action')(event,action);
  await act({type:'configure',config:{relay:'',name:'Settings fixture',enabled:false,background:false,sessionOnly:true}});
  await click('扫码绑定手机');
  await until(()=>js(`!!document.querySelector('.desktop-remote-pair img')`),'LAN QR missing from plugin detail');
  const local=await handlers.get('desktop:remote-state')(event);
  assert.equal(local.registered,false);assert.equal(local.config.enabled,true);assert.equal(local.config.background,true);assert.ok(local.pairing);assert.equal(local.lan.available,true);
  await click('取消配对');
  await until(()=>js(`!document.querySelector('.desktop-remote-pair img')`),'LAN QR did not cancel');
  report.checks.push('Unregistered computer can generate a one-time LAN QR without a relay address');
  await fill('.desktop-remote-panel input[type=url]',f.relay);
  await fill('.desktop-remote-panel input[type=password]',f.code);
  await click('注册电脑');
  await until(async()=> (await handlers.get('desktop:remote-state')(event)).registered,'Plugin form did not register the relay');
  await until(()=>js(`document.querySelector('.desktop-remote-panel input[type=url]').disabled&&!document.querySelector('.desktop-remote-panel input[type=password]')`),'Registered plugin form did not update');
  await until(async()=> (await handlers.get('desktop:remote-state')(event)).status==='online','Relay did not connect');
  await js(`Array.from(document.querySelectorAll('.desktop-remote-panel button')).find(b=>b.textContent==='扫码绑定手机').click()`);
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
  const nativeWindow = BrowserWindow.fromWebContents(host);
  await js(`document.querySelector('.desktop-remote-panel').scrollIntoView({block:'end',behavior:'instant'}); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  writeFileSync(join(data, 'settings.png'), (await host.capturePage()).toPNG());
  nativeWindow.close();
  await until(()=>process.platform==='darwin' ? nativeWindow.isMinimized() : !nativeWindow.isVisible(),'Window did not minimize or hide to tray');
  assert.equal(nativeWindow.isDestroyed(),false);
  if (nativeWindow.isMinimized()) nativeWindow.restore(); nativeWindow.show();
  report.checks.push('Default close minimizes on Mac or hides to tray while preserving the running window');
  await click('解除注册'); await click('确认解除注册');
  await until(async()=> !(await handlers.get('desktop:remote-state')(event)).registered,'Plugin form did not unregister');
  const background = await handlers.get('desktop:remote-state')(event);
  await act({type:'configure',config:{...background.config,enabled:false}});
  nativeWindow.close();
  await until(()=>process.platform==='darwin' ? nativeWindow.isMinimized() : !nativeWindow.isVisible(),'Closing without remote access did not preserve the app');
  assert.equal(nativeWindow.isDestroyed(),false);
  report.checks.push('Cancel removes QR; unregister drops pairing and remote identity; untrusted IPC is rejected');
}
app.setAppPath(root);
require(join(root,'dist/main/index.cjs'));
