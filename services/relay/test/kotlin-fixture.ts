import { DesktopRuntime } from '../../../src/main/runtime.ts';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { PrivateStore } from '../src/private-store.js';
import { createPrivateRelay } from '../src/private-server.js';
import { RemoteBridge } from '../../../src/runtime/remote/bridge.ts';
const store = new PrivateStore(':memory:');
const relay = createPrivateRelay(store, 'http://127.0.0.1:8787');
relay.server.listen(0, '127.0.0.1'); await once(relay.server,'listening');
const origin = `http://127.0.0.1:${(relay.server.address() as any).port}`;
const host = createServer(async(req,res)=>{
 if(req.url==='/?token=fixture'){res.setHeader('set-cookie','fixture_cookie=local');res.end();return;}
 if(req.headers.cookie!=='fixture_cookie=local'){res.writeHead(401);res.end();return;}
 if(req.method==='GET'){res.setHeader('content-type','application/octet-stream');res.end(Buffer.alloc(1024*1024+7,97));return;}
 const chunks: Buffer[]=[];for await (const c of req)chunks.push(c);res.setHeader('content-type','application/json');res.end(Buffer.concat(chunks));
});
const wss = new WebSocketServer({server:host,path:'/api/remote.mux'});
wss.on('connection', ws=>ws.on('message', raw=>ws.send(JSON.stringify({type:'item',streamId:'events',value:{type:'ready',clientId:'test-kotlin-client',host:{home:'/fixture'}}}))));
host.listen(0,'127.0.0.1');await once(host,'listening');
let endpoint=`http://127.0.0.1:${(host.address() as any).port}`;
let launchUrl=endpoint+'/?token=fixture';
let core: DesktopRuntime | undefined, cwd = '/fixture';
if (process.argv.includes('--real-host')) {
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 await mkdir(join(root,'.test-data'),{recursive:true});
 cwd=await mkdtemp(join(root,'.test-data/kotlin-host-'));const home=join(cwd,'home');await mkdir(home);
 await writeFile(join(home,'settings.yaml'),'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n');
 core=new DesktopRuntime({runtimeRoot:join(root,'.runtime'),entry:join(root,'.runtime/app/index.ts'),home:join(cwd,'core'),configHome:home,cwd,onExit:()=>{}});
 const ready=await core.start();endpoint=ready.endpoint;launchUrl=ready.launchUrl;
}

store.provision('kotlin@example.test','test-password-long');
const device=store.register(store.registration('kotlin@example.test'),'Kotlin fixture')!;
const invite=store.invite(device.deviceId),binding=store.claim('kotlin@example.test',invite.inviteId,invite.claimSecret,'Kotlin phone')!;
store.approve(device.deviceId,binding.bindingId,'control');
const key=Buffer.alloc(32,8).toString('base64url');
let online!:()=>void;const ready=new Promise<void>(r=>online=r);
const bridge=new RemoteBridge(WebSocket,endpoint,launchUrl,s=>{if(s.status==='online')online();});
await bridge.configure({enabled:true,credentials:{relay:origin,...device,bindings:[{id:binding.bindingId,name:'Kotlin',account:'kotlin@example.test',role:'control',key,revoked:false}]}});await ready;
// Ephemeral local test credentials; never a real account or user token.
console.log(JSON.stringify({origin,...binding,key,cwd}));
let closing=false;
async function close(){if(closing)return;closing=true;bridge.stop();await core?.stop();await relay.close();for(const ws of wss.clients)ws.terminate();wss.close();await new Promise<void>(r=>host.close(()=>r()));store.db.close();}
process.stdin.resume();process.stdin.on('end',()=>void close());process.on('SIGTERM',()=>void close());
