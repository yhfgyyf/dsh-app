import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { connectFixture } from '../tests/fixture-client.ts';
const root=fileURLToPath(new URL('..',import.meta.url));
const source = process.env.DSH_TEST_INSTALL_ROOT && process.env.DSH_TEST_PLUGIN_ROOT ? {} : JSON.parse(await readFile(join(root,'.build-runtime/source.json'),'utf8'));
const upgrade = { version: '0.1.3-alpha.2', globalPackage: process.env.DSH_TEST_INSTALL_ROOT ?? source.installRoot, plugins: process.env.DSH_TEST_PLUGIN_ROOT ?? source.pluginRoot };
const desktopRuntime=process.env.DSH_TEST_DESKTOP_RUNTIME??join(root,'.runtime');
await mkdir(join(root,'.test-data'),{recursive:true});
await mkdir(join(root,'docs/evidence'),{recursive:true});
const data=await mkdtemp(join(root,'.test-data/three-surfaces-'));
const home=join(data,'shared-home'); await mkdir(home);
const nm=join(upgrade.globalPackage,'node_modules');
for(const name of ['web','tui']) {
 const dir=join(home,'profiles',name);await mkdir(join(dir,'node_modules'),{recursive:true});
 const plugins=['dsh-auto-preset-router','dsh-audit-mode','dsh-progressive-tools',...(name==='tui'?['dsh-tui-app']:[])];
 const manifest={name:`dsh-test-${name}`,private:true,dependencies:Object.fromEntries(plugins.map(key=>[key,`file:${join(upgrade.plugins,key).replaceAll('\\','/')}`]))};
 for(const key of plugins) await symlink(join(upgrade.plugins,key),join(dir,'node_modules',key),process.platform==='win32'?'junction':'dir');
 await symlink(join(nm,'@deepseek-ai'),join(dir,'node_modules','@deepseek-ai'),process.platform==='win32'?'junction':'dir');
 await writeFile(join(dir,'package.json'),JSON.stringify(manifest,null,2));
 await writeFile(join(dir,'cordis.patch.yml'),'- id: session-telemetry-otel\n  disabled: true\n');
}
await writeFile(join(home,'settings.yaml'),'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n');
const processes:ChildProcess[]=[]; const cores:DesktopRuntime[]=[]; const clients:Awaited<ReturnType<typeof connectFixture>>[]=[];
const results:{name:string;status:string}[]=[];
const until=async(fn:()=>boolean|Promise<boolean>,timeout=15000)=>{const t=Date.now();while(!await fn()){if(Date.now()-t>timeout)throw Error('Timed out');await new Promise(r=>setTimeout(r,50));}};
const check=async(name:string,fn:()=>Promise<void>)=>{await fn();results.push({name,status:'pass'});console.log('PASS',name);};
async function desktop(){const core=new DesktopRuntime({runtimeRoot:desktopRuntime,entry:join(desktopRuntime,'app/index.ts'),home:join(data,'desktop-'+cores.length),configHome:home,cwd:data,onExit:()=>{}});cores.push(core);const ready=await core.start();const file=join(data,'desktop-connection-'+cores.length+'.json');await writeFile(file,JSON.stringify({owner:'dsh-desktop-test',...ready}),{mode:0o600});const client=await connectFixture(file);clients.push(client);return {core,client};}
function cli(profile:string,args:string[]=[]){const child=spawn(process.execPath,[join(upgrade.globalPackage,'lib/bin.js'),'--profile',profile,...args],{cwd:data,env:{...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'},stdio:['pipe','pipe','pipe']});processes.push(child);let output='';for(const stream of [child.stdout,child.stderr])stream?.on('data',c=>{output+=String(c)});child.on('error',()=>{});return{child,output:()=>output};}
async function stop(child:ChildProcess,signal:NodeJS.Signals='SIGTERM'){if(child.exitCode!==null||child.signalCode!==null)return;child.kill(signal);await until(()=>child.exitCode!==null||child.signalCode!==null,10000);}
async function tui(id:string){const t=cli('tui',['--resume',id]);await until(()=>t.output().includes('cannot start session')||t.output().includes('resumed ')||t.child.exitCode!==null,30000).catch(async e=>{await writeFile(join(data,'tui-error.log'),t.output().replace(/token=[^\s]+/g,'token=[redacted]'));throw e;});return t;}
async function digest(path:string):Promise<string>{const hash=createHash('sha256');async function walk(dir:string){for(const name of (await readdir(dir)).sort()){const p=join(dir,name),st=await stat(p);if(st.isDirectory())await walk(p);else if(name!=='session.lock'){hash.update(p.slice(path.length));hash.update(await readFile(p));}}}await walk(path);return hash.digest('hex');}
try{
 let app=await desktop();
 const w=cli('web',['--no-open','--port','0']);
 await until(()=>/dsh web: (http:\/\/[^\s]+)/.test(w.output())||w.child.exitCode!==null,45000);
 const match=w.output().match(/dsh web: (http:\/\/[^\s]+)/);if(!match){await writeFile(join(data,'web-error.log'),w.output().replace(/token=[^\s]+/g,'token=[redacted]'));throw Error('Web failed to boot; see private fixture log');}
 const launchUrl=match[1],endpoint=new URL(launchUrl).origin;const file=join(data,'web-connection.json');await writeFile(file,JSON.stringify({owner:'dsh-desktop-test',endpoint,launchUrl}),{mode:0o600});const web=await connectFixture(file);clients.push(web);
 const created=await app.client.rpc('session/create',{request:{cwd:data,agentPreset:'standard'}}); const sessionId=created.sessionId;
 await app.client.rpc('session/rename',{request:{sessionId,title:'three surface ownership'}});
 await until(async()=> (await web.rpc('session/list',{_request:{}})).items.some((x:any)=>x.sessionId===sessionId));
 await check('App and official Web boot on alpha.2 and share session listing',async()=>assert.ok(sessionId));
 const deny=async(client:typeof web,method:string)=>{const reply=await client.rpc('session/'+method,{request:{sessionId,title:'must not write'}},true);assert.equal(reply.ok,false);assert.equal(reply.error.code,'session/agent-busy');};
 await check('App owner rejects foreign Web rename and deletion without log changes',async()=>{const before=await digest(join(home,'sessions'));await deny(web,'rename');await deny(web,'delete');assert.equal(await digest(join(home,'sessions')),before);});
 await check('actual TUI rejects a session owned by App',async()=>{const t=await tui(sessionId);await until(()=>t.child.exitCode!==null);assert.equal(t.child.exitCode,1);assert.match(t.output(),/already.*owned|owned.*process|already.*open/i);});
 app.client.close();await app.core.stop();
 const terminal=await tui(sessionId);await writeFile(join(data,'tui-start.log'),terminal.output());
 await check('actual TUI resumes after App exits and excludes Web',async()=>{assert.equal(terminal.child.exitCode,null,terminal.output().slice(-1500));await deny(web,'rename');await deny(web,'delete');});
 await check('TUI lists and exports through current handle APIs',async()=>{terminal.child.stdin!.write('/sessions\n/resume\n/export\n');await until(()=>terminal.output().includes('exported '));const raw=await readFile(join(data,sessionId+'.jsonl'),'utf8');assert.ok(raw.includes('three surface ownership'));assert.ok(!terminal.output().includes('is not a function'));});
 terminal.child.stdin!.write('/exit\n');await until(()=>terminal.child.exitCode!==null);assert.equal(terminal.child.exitCode,0);
 await check('Web resumes and mutates after TUI releases ownership',async()=>{await web.rpc('session/rename',{request:{sessionId,title:'Web after TUI'}});});
 app=await desktop();
 await check('Web owner rejects restarted App mutations and deletion',async()=>{await deny(app.client,'rename');await deny(app.client,'delete');});
 await check('owning Web deletes after draining and shared sessions disappear',async()=>{await web.rpc('session/delete',{request:{sessionId}});await until(async()=>!(await app.client.rpc('session/list',{_request:{}})).items.some((x:any)=>x.sessionId===sessionId));});
 const next=await web.rpc('session/create',{request:{cwd:data,agentPreset:'standard'}});await web.rpc('session/rename',{request:{sessionId:next.sessionId,title:'race and crash'}});web.close();await stop(w.child);
 await check('two actual TUI processes racing to resume yield exactly one owner',async()=>{const a=cli('tui',['--resume',next.sessionId]),b=cli('tui',['--resume',next.sessionId]);await until(()=>a.child.exitCode!==null||b.child.exitCode!==null,30000);const loser=a.child.exitCode===1?a:b,winner=loser===a?b:a;assert.equal(loser.child.exitCode,1);assert.equal(winner.child.exitCode,null);assert.match(loser.output(),/already.*owned|owned.*process|already.*open/i);await stop(winner.child,'SIGKILL');const recovered=await tui(next.sessionId);assert.equal(recovered.child.exitCode,null,recovered.output().slice(-1000));recovered.child.stdin!.write('/exit\n');await until(()=>recovered.child.exitCode!==null);assert.equal(recovered.child.exitCode,0);});
}catch(e){console.error(e);process.exitCode=1;}finally{for(const c of clients)c.close();for(const c of cores)await c.stop();for(const p of processes)await stop(p).catch(()=>{});await writeFile(join(root,'docs/evidence/three-surfaces-alpha2.json'),JSON.stringify({at:new Date().toISOString(),data,version:upgrade.version,installRoot:upgrade.globalPackage,desktopRuntime,scope:'actual DesktopRuntime, official Web CLI and custom TUI CLI sharing disposable DSH_HOME; no external model calls',results},null,2));}
