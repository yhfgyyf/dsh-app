import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Reuse the relay's existing dependency in a source checkout; packaged builds carry that same module.
let ws: any;
try { ws = require('ws'); }
catch { ws = createRequire(new URL('../../relay/package.json', import.meta.url))('ws'); }
export const WebSocket = ws.WebSocket;
export const WebSocketServer = ws.WebSocketServer;
