// Exercise the complete production updater using an isolated, signed old-version copy.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAll, createPackage } from '@electron/asar';

if (process.platform !== 'darwin') throw new Error('This test uses a packaged macOS app.');
const root = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);
const artifact = JSON.parse(await readFile(join(root, 'release/latest.json'), 'utf8'));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const directory = await mkdtemp(join(root, '.test-data/packaged-update-'));
const target = join(directory, 'installed/DSH Desktop.app');
const data = join(directory, 'desktop');
const config = join(directory, 'config');
await mkdir(data, { recursive: true });
await mkdir(config);
const sentinel = join(config, 'user-data-sentinel.txt');
await writeFile(sentinel, 'existing user data must survive the complete upgrade');
await exec('/usr/bin/ditto', [artifact.app, target]);
const archive = join(target, 'Contents/Resources/app.asar');
const unpacked = join(directory, 'unpacked');
extractAll(archive, unpacked);
const pkg = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8'));
pkg.version = '0.1.1'; pkg.main = 'dist/updates-e2e.cjs';
await writeFile(join(unpacked, 'package.json'), JSON.stringify(pkg));
const fixture = { data, config, directory, artifact, version, name: basename(artifact.archive) };
await writeFile(join(unpacked, 'dist/updates-e2e.cjs'), `
const { app, ipcMain } = require('electron');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const fixture = ${JSON.stringify(fixture)};
process.env.DSH_DESKTOP_DATA_DIR = fixture.data;
process.env.DSH_DESKTOP_CONFIG_HOME = fixture.config;
process.env.DSH_HOME = fixture.config;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (url.startsWith('https://api.github.com/repos/yhfgyyf/dsh-app/releases')) return Response.json([{ tag_name: 'v' + fixture.version, draft: false, prerelease: true, published_at: new Date().toISOString(), assets: [{ name: fixture.name, state: 'uploaded', size: fixture.artifact.bytes, digest: 'sha256:' + fixture.artifact.sha256, browser_download_url: 'https://github.com/yhfgyyf/dsh-app/releases/download/v' + fixture.version + '/' + fixture.name }] }]);
  if (url === 'https://github.com/yhfgyyf/dsh-app/releases/download/v' + fixture.version + '/' + fixture.name) return new Response(readFileSync(fixture.artifact.archive));
  return originalFetch(input, options);
};
let started = false;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  const result = await listener(...args);
  if (channel === 'desktop:ready' && !started && args[0].sender.getURL().startsWith('http://127.0.0.1:')) {
    started = true;
    setTimeout(async () => {
      const js = code => args[0].sender.executeJavaScript(code, true);
      try {
        if (!app.isPackaged || app.getVersion() !== '0.1.1') throw new Error('Old packaged fixture identity is wrong');
        if (existsSync(join(fixture.directory, 'before-install.json'))) throw new Error('Old app relaunched after installation');
        const discovered = await js('window.dshDesktop.checkForUpdates()');
        if (discovered.status !== 'available') throw new Error(JSON.stringify(discovered));
        const ready = await js('window.dshDesktop.downloadUpdate()');
        if (ready.status !== 'ready') throw new Error(JSON.stringify(ready));
        await js("window.dshDesktop.setUpdateSchedule({mode:'daily',time:'18:45'})");
        writeFileSync(join(fixture.directory, 'before-install.json'), JSON.stringify({ pid: process.pid, packaged: app.isPackaged, currentVersion: app.getVersion(), ready }));
        const installing = await js('window.dshDesktop.installUpdate()');
        if (installing.status !== 'installing') throw new Error(JSON.stringify(installing));
      } catch (error) { writeFileSync(join(fixture.directory, 'failure.txt'), String(error.stack || error)); app.quit(); }
    }, 300);
  }
  return result;
});
require('./main/index.cjs');
`);
await createPackage(unpacked, archive);
for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) await exec('/usr/bin/plutil', ['-replace', key, '-string', '0.1.1', join(target, 'Contents/Info.plist')]);
await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target]);
await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const oldHash = await sha(archive);
const wantedHash = await sha(join(artifact.app, 'Contents/Resources/app.asar'));
const executable = join(target, 'Contents/MacOS/DSH Desktop');
const child = spawn(executable, [], { env: { ...process.env, DSH_DESKTOP_DATA_DIR: data, DSH_DESKTOP_CONFIG_HOME: config, DSH_HOME: config, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { const text = String(chunk).replace(/token=[^\s]+/g, 'token=[redacted]'); logs += text; appendFileSync(join(directory, 'live-app.log'), text); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function processes() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
  return stdout.trim().split('\n').map(line => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return match && { pid: +match[1], parent: +match[2], command: match[3] }; }).filter(Boolean);
}
async function until(fn, message, milliseconds = 90000) {
  const end = Date.now() + milliseconds;
  do {
    try { const failure = await readFile(join(directory, 'failure.txt'), 'utf8'); throw new Error(failure); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const value = await fn(); if (value) return value; await sleep(250);
  } while (Date.now() < end);
  throw new Error(message);
}
const report = { status: 'running', checks: [], directory, version };
let newPid, oldCore;
try {
  oldCore = await until(async () => (await processes()).find(p => p.parent === child.pid && p.command.includes('/runtime/bin/node'))?.pid, 'Old packaged core did not start');
  const transport = join(data, 'core/desktop-transport.json');
  const resultPath = join(data, 'updates/install-result.json');
  const result = await until(async () => { try { return JSON.parse(await readFile(resultPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; } }, 'Installer did not complete', 180000);
  assert.equal(result.status, 'installed', JSON.stringify(result)); assert.equal(result.version, version);
  assert.equal(alive(child.pid), false); assert.equal(alive(oldCore), false);
  report.checks.push('Packaged 0.1.1 discovers, downloads and validates the complete new release ZIP');
  report.checks.push('App and owned core exit before the external helper replaces the installation');
  assert.equal(await sha(archive), wantedHash);
  assert.equal(await sha(join(result.backup, 'Contents/Resources/app.asar')), oldHash);
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
  report.checks.push('Installed app matches the release bytes and signature; old app backup matches its original hash');
  newPid = await until(async () => (await processes()).find(p => p.command === executable && p.pid !== child.pid)?.pid, 'New app was not relaunched');
  const newCore = await until(async () => (await processes()).find(p => p.parent === newPid && p.command.includes('/runtime/bin/node'))?.pid, 'New app core did not start');
  await until(async () => {
    if ((await stat(transport)).mtimeMs < new Date(result.time).getTime()) return false;
    const { port } = JSON.parse(await readFile(transport, 'utf8'));
    // The standalone request has no app session cookie; 401 confirms the core's auth gate.
    try { return (await fetch('http://127.0.0.1:' + port + '/')).status === 401; } catch { return false; }
  }, 'New core transport was not ready');
  report.checks.push('Unmodified new production app relaunches and serves its owned core');
  assert.equal(await readFile(sentinel, 'utf8'), 'existing user data must survive the complete upgrade');
  const preferences = JSON.parse(await readFile(join(data, 'updates/preferences.json'), 'utf8'));
  assert.equal(preferences.mode, 'daily'); assert.equal(preferences.time, '18:45');
  report.checks.push('Existing user data and chosen daily check time survive installation');
  report.status = 'pass'; report.oldPid = child.pid; report.oldCore = oldCore; report.newPid = newPid; report.newCore = newCore; report.backup = result.backup;
} catch (error) { report.status = 'fail'; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  const owned = (await processes()).filter(p => p.command === executable);
  for (const processInfo of owned) { if (alive(processInfo.pid)) process.kill(processInfo.pid, 'SIGTERM'); }
  await sleep(1200);
  const remaining = (await processes()).filter(p => p.command.startsWith(join(target, 'Contents/Resources/runtime/bin/node')));
  for (const processInfo of remaining) process.kill(processInfo.pid, 'SIGTERM');
  await writeFile(join(directory, 'app.log'), logs);
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(root, '.test-data/packaged-update-latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
