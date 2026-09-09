// Real GitHub discovery and download through a loopback HTTP CONNECT proxy.
const { app, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { connect } = require('node:net');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const data = join(root, '.test-data/update-network', String(Date.now()));
mkdirSync(data, { recursive: true });
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
app.getVersion = () => '0.1.0';
const hosts = new Set(), sockets = new Set();
const allowed = ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
const proxy = createServer((_request, response) => { response.writeHead(405); response.end(); });
proxy.on('connect', (request, client, head) => {
  const target = new URL('https://' + request.url);
  if (!allowed.includes(target.hostname) || target.port && target.port !== '443') { client.destroy(); return; }
  hosts.add(target.hostname);
  const upstream = connect(443, target.hostname);
  for (const socket of [client, upstream]) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }
  upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client); });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});
const proxyReady = app.whenReady().then(async () => {
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await session.fromPartition('dsh-updates').setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:' + proxy.address().port, proxyBypassRules: '<local>;127.0.0.1;localhost' });
});
const report = { checks: [], failures: [] };
let finished = false, started = false;
const timeout = setTimeout(() => finish(new Error('Update network test timed out')), 180000);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  if (error) report.failures.push(String(error.stack ?? error));
  report.hosts = [...hosts];
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(root, '.test-data/update-network/latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const socket of sockets) socket.destroy();
  proxy.close(); app.quit();
}
app.on('quit', () => { if (report.failures.length) process.exit(1); });
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  const result = await listener(...args);
  if (channel === 'desktop:ready' && !started) {
    started = true;
    setTimeout(async () => {
      try {
        await proxyReady;
        const updates = session.fromPartition('dsh-updates');
        await updates.protocol.handle('https', () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/blocked-update' } }));
        await assert.rejects(updates.fetch('https://api.github.com/dsh-update-test/redirect', { credentials: 'omit' }), /ERR_BLOCKED_BY_CLIENT/);
        await updates.protocol.unhandle('https');
        assert.ok(!hosts.has('example.invalid'));
        report.checks.push('The update session blocks an off-GitHub redirect before any connection');
        const js = code => args[0].sender.executeJavaScript(code, true);
        const available = await js('window.dshDesktop.checkForUpdates()');
        assert.equal(available.status, 'available', JSON.stringify(available));
        assert.ok(hosts.has('api.github.com'));
        report.checks.push('Production updater discovers a published GitHub release through the configured Chromium proxy');
        const ready = await js('window.dshDesktop.downloadUpdate()');
        assert.equal(ready.status, 'ready', JSON.stringify(ready));
        assert.equal(ready.version, available.version);
        assert.ok(hosts.has('github.com'));
        assert.ok(hosts.has('release-assets.githubusercontent.com') || hosts.has('objects.githubusercontent.com'));
        report.version = ready.version;
        report.checks.push('GitHub asset redirects and the complete release download use the proxy and pass size and SHA-256 verification');
        finish();
      } catch (error) { finish(error); }
    }, 100);
  }
  return result;
});
app.setAppPath(root);
require('../dist/main/index.cjs');
