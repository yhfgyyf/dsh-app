import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';

/** Isolated NAT/HTTP frontends used by the Kotlin integration fixture; never run in production. */
export async function routeProxy(backendPort: () => number) {
  let mode = 'online';
  const sockets = new Set<Socket>();
  const requests: Record<string, number> = {};
  let upgrades = 0;
  const server = createServer((req, res) => {
    requests[req.url ?? ''] = (requests[req.url ?? ''] ?? 0) + 1;
    if (mode === 'offline') { req.resume(); res.writeHead(503); res.end(); return; }
    const upstream = request({ hostname: '127.0.0.1', port: backendPort(), path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    upgrades++;
    if (mode !== 'online') { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const upstream = connect(backendPort(), '127.0.0.1', () => {
      const headers = req.rawHeaders.reduce((s, h, i, all) => i % 2 ? s : s + `${h}: ${all[i + 1]}\r\n`, '');
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    stats: () => ({ requests: { ...requests }, upgrades, mode }),
    setMode: (value: string) => {
      if (!['online', 'offline', 'no-websocket'].includes(value)) throw new Error('Invalid fixture mode');
      mode = value; for (const socket of sockets) socket.destroy();
    },
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(r => server.close(() => r())); },
  };
}
