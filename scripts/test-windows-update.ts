// Exercise the real packaged restart path; only the release feed and old identity are fixtures.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { extractAll, createPackage } from '@electron/asar';
import { fileSha256, waitForExit } from '../src/updater/install.ts';
import { holdWindowsDll } from '../tests/windows-dll-fixture.ts';

if (process.platform !== 'win32') throw new Error('This test runs on Windows.');
const [target, installer, output] = process.argv.slice(2).map(value => resolve(value));
if (!target || !installer || !output) throw new Error('Usage: test-windows-update.ts INSTALL INSTALLER OUTPUT');
await mkdir(output, { recursive: true });
const execute = promisify(execFile);
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const archive = join(target, 'resources/app.asar');
const wantedHash = await fileSha256(archive);
const unpacked = join(output, 'old-app');
extractAll(archive, unpacked);
const pkg = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8'));
pkg.version = '0.1.1'; pkg.main = 'dist/updates-e2e.cjs';
await writeFile(join(unpacked, 'package.json'), JSON.stringify(pkg));
const fixture = { directory: output, installer, version, name: basename(installer), sha256: await fileSha256(installer) };
await writeFile(join(unpacked, 'dist/updates-e2e.cjs'), `
const { app, ipcMain, session } = require('electron');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const fixture = ${JSON.stringify(fixture)};
app.whenReady().then(() => {
  const updates = session.fromPartition('dsh-updates');
  const originalFetch = updates.fetch.bind(updates);
  updates.fetch = async (input, options) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/repos/yhfgyyf/dsh-app/releases')) return Response.json([{ tag_name: 'v' + fixture.version, draft: false, prerelease: true, published_at: new Date().toISOString(), assets: [{ name: fixture.name, state: 'uploaded', size: readFileSync(fixture.installer).length, digest: 'sha256:' + fixture.sha256, browser_download_url: 'https://github.com/yhfgyyf/dsh-app/releases/download/v' + fixture.version + '/' + fixture.name }] }]);
    if (url === 'https://github.com/yhfgyyf/dsh-app/releases/download/v' + fixture.version + '/' + fixture.name) return new Response(readFileSync(fixture.installer));
    return originalFetch(input, options);
  };
});
let started = false;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  const result = await listener(...args);
  if (channel === 'desktop:ready' && !started && args[0].sender.getURL().startsWith('http://127.0.0.1:')) {
    started = true;
    setTimeout(async () => {
      const js = code => args[0].sender.executeJavaScript(code, true);
      const until = async (code, message) => {
        const deadline = Date.now() + 40000;
        do { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
        throw new Error(message + ': ' + JSON.stringify(await js('window.dshDesktop.getUpdateState()')));
      };
      try {
        if (!app.isPackaged || app.getVersion() !== '0.1.1') throw new Error('Old packaged fixture identity is wrong');
        if (existsSync(join(fixture.directory, 'before-install.json'))) throw new Error('Old app relaunched after installation');
        await until("!!document.querySelector('.desktop-update-icon[data-update-state=available]')", 'Startup discovery did not offer the update');
        await js("document.querySelector('.desktop-update-icon').click()");
        await until("!!document.querySelector('.desktop-update-icon[data-update-state=ready]')", 'Update did not download and verify');
        await js("window.dshDesktop.setUpdateSchedule({mode:'daily',time:'18:45'})");
        writeFileSync(join(fixture.directory, 'before-install.json'), JSON.stringify({ pid: process.pid, currentVersion: app.getVersion(), ready: await js('window.dshDesktop.getUpdateState()') }));
        await js("document.querySelector('.desktop-update-icon').click()");
      } catch (error) { writeFileSync(join(fixture.directory, 'failure.txt'), String(error.stack || error)); app.quit(); }
    }, 300);
  }
  return result;
});
require('./main/index.cjs');
`);
await createPackage(unpacked, archive);
const before = await fileSha256(archive);
const executable = join(target, 'DSH Desktop.exe');
const node = join(target, 'resources/runtime/bin/node.exe');
const data = process.env.DSH_DESKTOP_DATA_DIR!;
assert.ok(data, 'An isolated desktop profile is required');
const holder = await holdWindowsDll(join(target, 'd3dcompiler_47.dll'), output);
const log = openSync(join(output, 'old-app.log'), 'a');
const child = spawn(executable, [], { windowsHide: false, cwd: target, stdio: ['ignore', log, log] });
closeSync(log);
await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function processes() {
  const script = `@((Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${quote(executable)} -or $_.ExecutablePath -eq ${quote(node)} }) | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine) | ConvertTo-Json -Compress`;
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const result = JSON.parse(stdout || '[]');
  return (Array.isArray(result) ? result : [result]) as { ProcessId: number; ParentProcessId: number; ExecutablePath: string; CommandLine: string }[];
}
async function until<T>(fn: () => Promise<T>, message: string, milliseconds = 90000) {
  const deadline = Date.now() + milliseconds;
  do {
    try { throw new Error(await readFile(join(output, 'failure.txt'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = await fn(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error(message);
}
const report: { status: string; checks: string[]; oldPid?: number; oldCore?: number; newPid?: number; newCore?: number; error?: string } = { status: 'running', checks: [] };
try {
  report.oldPid = child.pid;
  report.oldCore = await until(async () => (await processes()).find(p => p.ParentProcessId === child.pid && p.ExecutablePath === node)?.ProcessId, 'Old core did not start');
  const result = await until(async () => {
    try { return JSON.parse(await readFile(join(data, 'updates/install-result.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }, 'External updater did not finish after clicking restart', 180000);
  assert.equal(result.status, 'installed', JSON.stringify(result));
  assert.equal(result.version, version);
  assert.equal(alive(child.pid!), false); assert.equal(alive(report.oldCore!), false);
  report.checks.push('Packaged app discovers, downloads and verifies the full installer; the real restart icon exits the app and core');
  assert.equal(await fileSha256(archive), wantedHash);
  assert.equal(await fileSha256(join(result.backup, 'resources/app.asar')), before);
  report.checks.push('External updater installs matching release bytes and retains the complete previous-app backup');
  report.newPid = await until(async () => (await processes()).find(p => p.ExecutablePath === executable && p.ProcessId !== child.pid && !p.CommandLine.includes('--type='))?.ProcessId, 'Updated application was not automatically relaunched');
  report.newCore = await until(async () => (await processes()).find(p => p.ParentProcessId === report.newPid && p.ExecutablePath === node)?.ProcessId, 'Relaunched application did not start its owned core');
  await until(async () => {
    const { port } = JSON.parse(await readFile(join(data, 'core/desktop-transport.json'), 'utf8'));
    try { return (await fetch('http://127.0.0.1:' + port + '/')).status === 401; } catch { return false; }
  }, 'Relaunched core did not serve its protected transport');
  report.checks.push('Unmodified new application automatically relaunches with a new PID and a serving owned core');
  assert.equal(holder.exitCode, null);
  assert.equal(await fileSha256(join(target, 'd3dcompiler_47.dll')), await fileSha256(join(result.backup, 'd3dcompiler_47.dll')));
  report.checks.push('The old d3dcompiler DLL remains mapped throughout installation and automatic restart without blocking either');
  const preferences = JSON.parse(await readFile(join(data, 'updates/preferences.json'), 'utf8'));
  assert.equal(preferences.mode, 'daily'); assert.equal(preferences.time, '18:45');
  report.checks.push('The update preserves the configured daily update schedule');
  report.status = 'pass';
} catch (error) {
  report.status = 'fail'; report.error = String((error as Error).stack ?? error); process.exitCode = 1;
  for (const processInfo of await processes()) { try { process.kill(processInfo.ProcessId); } catch {} }
} finally {
  holder.stdin.end('\n'); await waitForExit(holder.pid!);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
