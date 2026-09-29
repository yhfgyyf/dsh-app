import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { connectFixture } from '../tests/fixture-client.ts';
import { RemoteTestClient } from '../tests/remote-client.ts';
import { PrivateStore } from '../services/relay/dist/private-store.js';
import { createPrivateRelay } from '../services/relay/dist/private-server.js';
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.test-data'), {recursive:true});
const data = await mkdtemp(join(root, '.test-data/mobile-remote-'));
const home = join(data, 'home'); await mkdir(home);
await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n');
const store = new PrivateStore(join(data, 'relay.db'));
const relay = createPrivateRelay(store, 'http://127.0.0.1:8787');
relay.server.listen(0, '127.0.0.1'); await once(relay.server,'listening');
const origin = `http://127.0.0.1:${relay.server.address().port}`;
let modelCalls = 0;
const mock = createServer(async (req,res)=>{
 if(req.url?.endsWith('/models')) {res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'deepseek-flash',object:'model'}]}));return;}
 if(!req.url?.endsWith('/messages')) {res.writeHead(404);res.end();return;}
 let body='';for await(const c of req)body+=c;const request=JSON.parse(body);modelCalls++;
 const message={id:crypto.randomUUID(),type:'message',role:'assistant',model:request.model,content:[{type:'text',text:'REMOTE_REPLY_OK'}],stop_reason:'end_turn',usage:{input_tokens:12,output_tokens:8}};
 if(!request.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(message));return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const emit=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
 emit('message_start',{message:{...message,content:[],stop_reason:null}});
 emit('content_block_start',{index:0,content_block:{type:'text',text:''}});
 emit('content_block_delta',{index:0,delta:{type:'text_delta',text:'REMOTE_REPLY_OK'}});
 emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:8}});emit('message_stop',{});res.end();
});
mock.listen(0,'127.0.0.1');await once(mock,'listening');
await mkdir(join(data,'core'));
await writeFile(join(data,'core/desktop.patch.yml'),`- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${mock.address().port}\n    apiKeyEnv: DSH_DESKTOP_FIXTURE_KEY\n    maxTokens: 4096\n`);
process.env.DSH_DESKTOP_FIXTURE_KEY='local-test-only';
const core = new DesktopRuntime({runtimeRoot:join(root,'.runtime'),entry:join(root,'.runtime/app/index.ts'),home:join(data,'core'),configHome:home,cwd:data,onExit:()=>{}});
const phone = new RemoteTestClient();
let desktop;
try {
 const ready = await core.start();
 const connection = join(data,'connection.json'); await writeFile(connection,JSON.stringify({owner:'dsh-desktop-test',...ready}),{mode:0o600});
 desktop = await connectFixture(connection);
 store.provision('integration@example.test','test-password-long');
 const d = store.register(store.registration('integration@example.test'),'Fixture Desktop');
 const invite = store.invite(d.deviceId), b = store.claim('integration@example.test',invite.inviteId,invite.claimSecret,'Fixture Android');
 store.approve(d.deviceId,b.bindingId,'control');
 const key = Buffer.alloc(32, 7).toString('base64url');
 await core.configureRemote({enabled:true,credentials:{...d,relay:origin,bindings:[{id:b.bindingId,name:'phone',account:'integration@example.test',role:'control',key,revoked:false}]}});
 for(let attempt=0;attempt<30;attempt++){try {await phone.connect(origin,b.bindingId,b.bindingToken,key); break;} catch(e){if(attempt===29)throw e;await new Promise(r=>setTimeout(r,100));}}
 async function rpc(method,args){ const result=await phone.http('/api/'+method,Buffer.from(JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}}))); assert.equal(result.status,200); const value=JSON.parse(result.body); assert.equal(value.result.ok,true,JSON.stringify(value.result.error));return value.result.value; }
 const created=await rpc('session/create',{request:{cwd:data,agentPreset:'standard'}});
 await rpc('session/rename',{request:{sessionId:created.sessionId,title:'Mobile remote shared Host'}});
 assert.ok((await desktop.rpc('session/list',{_request:{}})).items.some(s=>s.sessionId===created.sessionId));
 await desktop.rpc('session/rename',{request:{sessionId:created.sessionId,title:'Desktop rename visible on phone'}});
 const listed=(await rpc('session/list',{_request:{}})).items.find(s=>s.sessionId===created.sessionId); assert.ok(JSON.stringify(listed).includes('Desktop rename visible on phone'),JSON.stringify(listed));
 const journal=desktop.follow('session/follow',{request:{address:{kind:'session',sessionId:created.sessionId},assistantStream:true}});
 await journal.wait(frames=>frames.some(f=>f.type==='snapshot'));
 const prompt={request:{sessionId:created.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'Reply REMOTE_REPLY_OK. No tools.'}]}};
 const accepted = await rpc('session/prompt',prompt); const duplicate = await rpc('session/prompt',prompt); assert.deepEqual(duplicate,accepted);
 await journal.wait(frames=>frames.some(f=>f.type==='event' && f.event.type==='turn/end'),20000);
 assert.ok(journal.frames.some(f=>f.type==='event' && f.event.type==='assistant/message' && JSON.stringify(f.event.data).includes('REMOTE_REPLY_OK')));
 assert.equal(journal.frames.find(f=>f.type==='event' && f.event.type==='turn/end').event.data.reason.kind,'completed');
 assert.equal(journal.frames.filter(f=>f.type==='event' && f.event.type==='turn/end').length,1,'Duplicate requestId produces one completed turn');
 assert.ok(modelCalls >= 1); journal.close();
 phone.send({type:'ws_open',channel:'mux'});assert.equal((await phone.next()).type,'ws_open');
 phone.send({type:'ws_data',channel:'mux',text:JSON.stringify({type:'open',streamId:'events',endpoint:'$events',payload:{args:{}}})});
 const frame=await phone.next();assert.equal(frame.type,'ws_data');assert.equal(JSON.parse(Buffer.from(frame.data,'base64')).value.type,'ready');
 await core.configureRemote({enabled:false});
 for(let i=0;i<100 && phone.socket.readyState<2;i++) await new Promise(r=>setTimeout(r,20));
 assert.ok(phone.socket.readyState>=2,'Remote socket closed after disable');
 assert.ok((await desktop.rpc('session/list',{_request:{}})).items.some(s=>s.sessionId===created.sessionId));
 await writeFile(join(data,'result.json'),JSON.stringify({ok:true,checks:['phone creates session in owned Host','desktop sees phone session','phone sees desktop rename','remote prompt produces model reply','duplicate requestId executes once','remote mux ready','disable disconnects phone','desktop remains usable'],network:'loopback only',mockModelCalls:modelCalls,externalModelCalls:0},null,2));
 console.log('PASS: actual Desktop Host and relay share sessions; mux, disable and local continuity verified.');
 console.log('Evidence: '+join(data,'result.json'));
} finally {phone.close();desktop?.close();await core.stop();await relay.close();await new Promise(r=>mock.close(r));store.db.close();}
