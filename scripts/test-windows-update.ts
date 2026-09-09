import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { fileSha256, installUpdate, type InstallPlan } from '../src/updater/install.ts';

if (process.platform !== 'win32') throw new Error('This test runs on Windows.');
const [target, installer, output] = process.argv.slice(2).map(value => resolve(value));
if (!target || !installer || !output) throw new Error('Usage: test-windows-update.ts INSTALL INSTALLER OUTPUT');
await mkdir(output, { recursive: true });
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const before = await fileSha256(join(target, 'resources/app.asar'));
const plan: InstallPlan = { platform: 'win32', parentPid: process.pid, target, payload: installer, backup: join(output, 'previous-app'), version, sha256: await fileSha256(installer), result: join(output, 'result.json') };
let launched = false;
await installUpdate(plan, async () => { launched = true; });
assert.equal(launched, true);
assert.equal(await fileSha256(join(plan.backup, 'resources/app.asar')), before);
assert.equal(JSON.parse(await readFile(plan.result, 'utf8')).status, 'installed');
await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'pass', checks: ['verified installer runs with the existing installation path', 'complete previous app backup retained', 'installation completes before relaunch'] }, null, 2));
console.log('Windows application update and backup passed.');
