// Electron-owned lifecycle and renderer boot integration, without synthetic UI input.
const { app, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const childProcess = require('node:child_process');
const root = join(__dirname, '..');
const data = join(root, '.test-data', 'native-owned');
mkdirSync(data, { recursive: true });
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
const report = { ready: false, failures: [], expectedDisconnectMessages: [], checks: [], security: {}, loads: [], corePid: undefined, coreStopped: false };
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (String(args[1]?.[0]).replaceAll('\\', '/').endsWith('/app/index.ts')) { report.corePid = child.pid; report.coreCommand = [args[0], ...args[1]]; }
  return child;
};
const clean = text => String(text).replace(/token=[^\s&"']+/g, 'token=[redacted]');
let finished = false;
let readyCount = 0;
let originalCorePid;
let originalEndpoint;
let testingDisconnect = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  app.quit();
}
process.on('exit', () => {
  try { process.kill(report.corePid, 0); } catch { report.coreStopped = true; }
  if (!report.coreStopped) report.failures.push('Owned DSH process remained after App quit');
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exit(1);
});
const timeout = setTimeout(() => { report.failures.push('Desktop ready timeout'); finish(); }, 50000);
const handle = ipcMain.handle.bind(ipcMain);
const handlers = new Map();
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener);
  return handle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'desktop:ready') {
      readyCount++;
      if (readyCount > 1) {
        try {
          const event = args[0];
          const info = await handlers.get('desktop:info')(event);
          assert.equal(info.endpoint, originalEndpoint);
          if (readyCount === 2) {
            assert.equal(report.corePid, originalCorePid);
            report.checks.push('Runtime status page returns to the same owned core without reusing an expired login');
            setTimeout(() => {
              event.sender.once('did-finish-load', () => {
                const fresh = { sender: event.sender, senderFrame: event.sender.mainFrame };
                setTimeout(() => handlers.get('desktop:reconnect')(fresh).catch(error => { report.failures.push(clean(error)); finish(); }), 250);
              });
              process.kill(report.corePid, 'SIGTERM');
            }, 250);
          } else {
            assert.notEqual(report.corePid, originalCorePid);
            report.checks.push('Core exit shows recovery UI; restart boots a new owned core on the saved port');
            testingDisconnect = false;
            setTimeout(finish, 500);
          }
        } catch (error) { report.failures.push(clean(error.stack ?? error)); finish(); }
        return result;
      }
      report.ready = true;
      try {
        const event = args[0];
        const info = await handlers.get('desktop:info')(event);
        assert.equal(new URL(info.endpoint).hostname, '127.0.0.1');
        assert.equal(info.connected, true);
        assert.ok(report.corePid);
        originalCorePid = report.corePid;
        originalEndpoint = info.endpoint;
        const graph = await handlers.get('desktop:boot')(event);
        assert.ok(graph.entries.length >= 47);
        report.checks.push(`App-owned core, ${graph.entries.length} DSH client modules, independent frontend boot`);
        for (const invalid of [{ ...event, sender: {} }, { ...event, senderFrame: { url: 'http://untrusted.invalid/' } }]) await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:info')(invalid)));
        await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:external')(event, 'javascript:alert(1)')));
        await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:color-scheme')(event, 'unsupported')));
        report.checks.push('IPC rejects untrusted senders, executable URLs and invalid values');
        for (const invalid of [{ ...event, sender: {} }, { ...event, senderFrame: { url: 'http://untrusted.invalid/' } }]) await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:computer-stop')(invalid)));
        const computer = await handlers.get('desktop:computer-state')(event);
        assert.equal(computer.enabled, false);
        for (const invalid of [{ ...event, sender: {} }, { ...event, senderFrame: { url: 'http://untrusted.invalid/' } }]) await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:computer-enabled')(invalid, true)));
        await assert.rejects(Promise.resolve().then(() => handlers.get('desktop:computer-enabled')(event, 'true')));
        assert.equal(computer.driverVersion, '0.25.0');
        assert.equal(computer.phase, 'idle');
        assert.equal(typeof computer.stopShortcutAvailable, 'boolean');
        assert.equal(handlers.has('desktop:computer-act'), false);
        assert.equal(handlers.has('desktop:computer-observe'), false);
        report.checks.push('Computer status and emergency stop use trusted App IPC; renderer exposes no native action endpoint');
        const ses = session.fromPartition('persist:dsh');
        const document = await (await ses.fetch(info.endpoint)).text();
        assert.equal(document, readFileSync(join(root, 'dist/renderer/app/index.html'), 'utf8'));
        assert.ok(!document.includes('__DSH_BOOT__'));
        assert.equal((await ses.fetch(info.endpoint, { bypassCustomProtocolHandlers: true })).status, 204);
        report.checks.push('Own HTML served byte-for-byte; core has no Web App homepage (HTTP 204)');
        for (const name of ['plugin.js', 'theme.css']) {
          const response = await ses.fetch(info.endpoint + '/__dsh_desktop__/' + name);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(join(root, 'dist/renderer', name)));
        }
        report.checks.push('Electron protocol serves exact desktop module and theme bytes');
        await ses.cookies.flushStore();
      } catch (error) { report.failures.push(clean(error.stack ?? error)); }
      setTimeout(async () => {
        if (report.failures.length) return finish();
        try {
          const contents = args[0].sender;
          testingDisconnect = true;
          await handlers.get('desktop:connection')({ sender: contents, senderFrame: contents.mainFrame });
          await handlers.get('desktop:connect')({ sender: contents, senderFrame: contents.mainFrame });
        } catch (error) { report.failures.push(clean(error.stack ?? error)); finish(); }
      }, 300);
    }
    return result;
  });
};
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => {
    if (details.level !== 'error') return;
    const text = clean(details.message);
    if (testingDisconnect && text === '[cordis-client-runner] syncing inspect providers failed: Error: client api: dynamicCordisRunner/syncInspectManifest has no active Connection') report.expectedDisconnectMessages.push(text);
    else { report.failures.push(text); console.log('RENDERER ERROR', text, details.sourceId, details.lineNumber); }
  });
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => { if (mainFrame && code !== -3) report.failures.push(`${code}: ${description} (${clean(url)})`); });
  contents.on('did-finish-load', () => {
    report.loads.push(clean(contents.getURL()));
    const prefs = contents.getLastWebPreferences();
    report.security = { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity };
  });
});
app.setAppPath(root);
require('../dist/main/index.cjs');
