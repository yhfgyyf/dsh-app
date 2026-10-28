// Exercise Chromium capture with a fake device: never record the user's microphone.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
mkdirSync(join(root, '.test-data'), { recursive: true });
const data = mkdtempSync(join(root, '.test-data/voice-input-'));
process.env.DSH_DESKTOP_DATA_DIR = data;
process.env.DSH_DESKTOP_CONFIG_HOME = join(data, 'core');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const report = { electron: process.versions.electron, platform: process.platform, checks: [], errors: [] };
let started = false, finished = false;
app.on('quit', () => { if (report.errors.length) process.exit(1); });
const timeout = setTimeout(() => finish(new Error('Voice capture test timed out')), 60000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) report.errors.push(String(error.stack ?? error));
  writeFileSync(join(data, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(root, '.test-data/voice-input-latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, data }, null, 2));
  process.exitCode = report.errors.length ? 1 : 0;
  app.quit();
}
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  const result = await listener(...args);
  if (channel === 'desktop:ready' && !started) {
    started = true;
    run(args[0].sender).then(() => finish(), finish);
  }
  return result;
});
async function run(host) {
  const capture = `async (constraints) => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      const tracks = stream.getTracks().map(track => ({ kind: track.kind, state: track.readyState }));
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data.size);
      const done = new Promise(resolve => recorder.onstop = resolve);
      recorder.start();
      await new Promise(resolve => setTimeout(resolve, 400));
      recorder.stop();
      await done;
      return { tracks, bytes: chunks.reduce((a, b) => a + b, 0) };
    } catch (error) { return { error: error.name }; }
    finally { stream?.getTracks().forEach(track => track.stop()); }
  }`;
  const audio = await host.executeJavaScript(`(${capture})({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })`, true);
  assert.equal(audio.error, undefined, `Official voice capture constraints failed: ${JSON.stringify(audio)}`);
  assert.deepEqual(audio.tracks, [{ kind: 'audio', state: 'live' }]);
  assert.ok(audio.bytes > 0);
  report.checks.push('DSH main document records audio with the official voice constraints');
  for (const constraints of [{ video: true }, { audio: true, video: true }]) {
    const result = await host.executeJavaScript(`(${capture})(${JSON.stringify(constraints)})`, true);
    assert.equal(result.error, 'NotAllowedError');
  }
  report.checks.push('Camera and combined audio/video capture remain denied');
  const child = await host.executeJavaScript(`(async () => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<!doctype html><title>Untrusted embedded document</title>';
    const ready = new Promise(resolve => frame.onload = resolve);
    document.body.append(frame);
    await ready;
    try {
      const stream = await frame.contentWindow.navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      return 'allowed';
    } catch (error) { return error.name; }
    finally { frame.remove(); }
  })()`, true);
  assert.equal(child, 'NotAllowedError');
  report.checks.push('Embedded same-origin frames cannot record audio');
  const other = new BrowserWindow({ show: false, webPreferences: { session: host.session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    // The setup document is a secure origin, but is not the trusted DSH document.
    await other.loadURL('dsh://app/index.html');
    const result = await other.webContents.executeJavaScript(`(${capture})({ audio: true })`, true);
    assert.equal(result.error, 'NotAllowedError');
  } finally { other.destroy(); }
  report.checks.push('Other windows sharing the session cannot record audio');
}
app.setAppPath(root);
require('../dist/main/index.cjs');
