import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const [runtimeArg, executableArg, dataArg] = process.argv.slice(2);
const runtime = resolve(runtimeArg), executable = resolve(executableArg), data = resolve(dataArg);
await mkdir(join(data, 'workspace'), { recursive: true });
const report = { passed: false, passes: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addonProbe = `
const assert=require('node:assert/strict'),fs=require('node:fs'),{createRequire}=require('node:module'),{Worker}=require('node:worker_threads');
const root=${JSON.stringify(runtime)},r=createRequire(root+'/package.json'),manifest=r('./package.json');
for(const name of Object.keys(manifest.dependencies)){
 const file=root+'/node_modules/'+name+'/package.json';
 assert(fs.existsSync(file),'missing mandatory dependency: '+name);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).name,name);
}
const a=r('node-addon-require-builtin'),info=a.getBindingInfo();
assert.equal(info.product,'require-builtin');assert.equal(info.abi,'node-v127');
assert.equal(info.bindingSource,'local-build');
assert(info.bindingPath.startsWith(root+'/node_modules/node-addon-require-builtin/'));
assert.equal(a.requireBuiltin('fs'),require('fs'));
assert.equal(typeof a.requireBuiltin('internal/modules/esm/loader').getOrInitializeCascadedLoader,'function');
assert.equal(typeof a.requireBuiltin('internal/bootstrap/realm').internalBinding,'function');
assert.throws(()=>a.requireBuiltin('not-a-real-builtin'));
const worker=new Worker('const {parentPort}=require("node:worker_threads");const a=require('+JSON.stringify(r.resolve('node-addon-require-builtin'))+');parentPort.postMessage(typeof a.requireBuiltin("internal/bootstrap/realm").internalBinding);',{eval:true});
worker.on('message',value=>{assert.equal(value,'function');console.log(JSON.stringify({passed:true,node:process.version,arch:process.arch,requiredDependenciesPresent:Object.keys(manifest.dependencies).length,workerPassed:true,backend:info.backend,abi:info.abi}));});
worker.on('error',error=>{console.error(error);process.exitCode=1;});`;
const probe = await promisify(execFile)(executable, ['-e', addonProbe], { timeout: 30000, maxBuffer: 1024 * 1024 });
const addon = JSON.parse(probe.stdout.trim());
assert.equal(addon.passed, true); assert.equal(addon.arch, 'loong64'); assert.equal(addon.node, 'v22.16.0');
report.addon = addon;
console.log(JSON.stringify({ phase: 'mandatory-dependencies-and-worker', ...addon }));
let savedSession;
for (let iteration = 1; iteration <= 2; iteration++) {
  let log = '', child, exited = false;
  const pass = { iteration, checks: [] };
  try {
    const messages = [];
    child = spawn(executable, [join(runtime, 'app/index.ts')], {
      cwd: join(data, 'workspace'),
      env: { ...process.env, DSH_HOME: join(data, 'config'), DSH_DESKTOP_CONFIG_HOME: join(data, 'config'),
        DSH_DESKTOP_STATE_HOME: join(data, 'state'), DSH_DESKTOP_RUNTIME_ROOT: runtime,
        DSH_DESKTOP_PORT: '0', DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
    child.on('message', m => messages.push(m)); child.on('exit', () => { exited = true; });
    const deadline = Date.now() + 90000;
    let ready;
    while (Date.now() < deadline && !exited) {
      ready = messages.find(m => m.type === 'ready'); if (ready) break;
      await sleep(100);
    }
    assert(ready, 'Actual Host did not become ready; see private log');
    assert(ready.graph.entries.length >= 60);
    pass.clientModules = ready.graph.entries.length;
    pass.checks.push('Actual packaged Host prepares and starts on LoongArch Node22 with its full client-module graph');
    const response = await fetch(ready.launchUrl, { redirect: 'manual' });
    const cookie = response.headers.getSetCookie().map(v => v.split(';')[0]).join(';');
    assert(cookie, 'Host authentication cookie missing');
    async function rpc(method, args) {
      const r = await fetch(ready.endpoint + '/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) });
      assert(r.ok, method + ' HTTP ' + r.status);
      const result = await r.json(); assert(result.result.ok, JSON.stringify(result.result.error)); return result.result.value;
    }
    if (iteration === 1) {
      const w = await rpc('workspace/create', { request: { path: join(data, 'workspace') } });
      savedSession = (await rpc('session/create', { request: { workspaceId: w.workspace.workspaceId, agentPreset: 'standard' } })).sessionId;
      assert(savedSession);
      await writeFile(join(data, 'session.json'), JSON.stringify({ savedSession }));
      pass.checks.push('Create a workspace and session through the real authenticated Host API without model calls');
    }
    let listed;
    for (let attempt = 0; attempt < 100; attempt++) {
      listed = await rpc('session/list', { _request: {} });
      if (listed.items.some(item => item.sessionId === savedSession)) break;
      await sleep(100);
    }
    assert(listed.items.some(item => item.sessionId === savedSession));
    if (iteration === 2) pass.checks.push('The same persisted session is available after a complete Host restart');
    assert.deepEqual(JSON.parse(await readFile(join(data, 'state/profiles/desktop/local-plugins/package.json'), 'utf8')), { private: true });
    pass.checks.push('Actual profile initialization creates its anonymous local-plugin manifest');
    child.send({ type: 'shutdown' });
    for (let n = 0; n < 100 && !exited; n++) await sleep(100);
    assert(exited && child.exitCode === 0, 'Host did not shut down cleanly');
    pass.checks.push('Normal shutdown exits the owned Host cleanly'); pass.passed = true; report.passes.push(pass);
    console.log(JSON.stringify(pass));
  } finally {
    if (child && !exited) child.kill('SIGTERM');
    await writeFile(join(data, `host-${iteration}.private.log`), log.replace(/token=[^\s&"']+/g, 'token=[redacted]'));
    await writeFile(join(data, `host-${iteration}.json`), JSON.stringify(pass, null, 2) + '\n');
  }
}
report.passed = report.passes.length === 2;
await writeFile(join(data, 'report.json'), JSON.stringify(report, null, 2) + '\n');
