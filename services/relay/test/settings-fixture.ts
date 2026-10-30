import { once } from 'node:events';
import { PrivateStore } from '../src/private-store.js';
import { createPrivateRelay } from '../src/private-server.js';
const store = new PrivateStore(':memory:');
store.provision('ui@example.test','test-password-long');
const relay=createPrivateRelay(store,'http://127.0.0.1:8787');
relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
console.log(JSON.stringify({relay:`http://127.0.0.1:${(relay.server.address() as any).port}`,code:store.registration('ui@example.test')}));
process.stdin.resume();process.stdin.on('end',()=>void relay.close().then(()=>store.db.close()));
