import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileSha256, installUpdate, run, validatePlan, waitForExit, type InstallPlan } from '../src/updater/install.ts';
import { prepareMacUpdate } from '../src/main/updates.ts';

const mac = { skip: process.platform !== 'darwin' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-install-'));
  const target = join(directory, 'installed', 'DSH Desktop.app');
  const payload = join(directory, 'staged', 'DSH Desktop.app');
  for (const [path, text] of [[target, 'old version'], [payload, 'new version']]) {
    await mkdir(join(path, 'Contents/MacOS'), { recursive: true });
    await mkdir(join(path, 'Contents/Resources'));
    await cp('/usr/bin/true', join(path, 'Contents/MacOS/DSH Desktop'));
    await writeFile(join(path, 'Contents/Resources/app.asar'), text);
    await writeFile(join(path, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.dsh.desktop</string><key>CFBundleExecutable</key><string>DSH Desktop</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>0.1.2</string><key>CFBundleShortVersionString</key><string>0.1.2</string></dict></plist>');
    await run('/usr/bin/codesign', ['--force', '--sign', '-', path]);
  }
  const plan: InstallPlan = { platform: 'darwin', parentPid: process.pid, target, payload, backup: join(directory, 'installed/backup.app'), version: '0.1.2', sha256: await fileSha256(join(payload, 'Contents/Resources/app.asar')), result: join(directory, 'result.json') };
  return { directory, plan };
}

test('macOS archive preparation validates the signature, bundle identity and version', mac, async () => {
  const { directory, plan } = await fixture();
  const archive = join(directory, 'update.zip');
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', plan.payload, archive]);
  const prepared = await prepareMacUpdate(archive, directory, '0.1.2');
  assert.equal(await readFile(join(prepared, 'Contents/Resources/app.asar'), 'utf8'), 'new version');
  const wrong = join(directory, 'wrong'); await mkdir(wrong);
  await assert.rejects(prepareMacUpdate(archive, wrong, '9.0.0'), /版本不匹配/);
});

test('macOS installer swaps the app, keeps a complete backup, and leaves user data alone', mac, async () => {
  const { directory, plan } = await fixture();
  const sentinel = join(directory, 'user-settings.json'); await writeFile(sentinel, 'preserve');
  let launches = 0;
  await installUpdate(plan, async () => { launches++; assert.equal(await readFile(join(plan.target, 'Contents/Resources/app.asar'), 'utf8'), 'new version'); });
  assert.equal(launches, 1);
  assert.equal(await readFile(join(plan.backup, 'Contents/Resources/app.asar'), 'utf8'), 'old version');
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
  assert.equal(JSON.parse(await readFile(plan.result, 'utf8')).status, 'installed');
});

test('macOS installer rejects tampering and restores the original if the replacement cannot launch', mac, async () => {
  const { plan } = await fixture();
  await assert.rejects(installUpdate({ ...plan, sha256: '0'.repeat(64) }), /发生|变化/);
  let launches = 0;
  await assert.rejects(installUpdate(plan, async () => { launches++; throw new Error('launch failed'); }), /launch failed/);
  assert.equal(launches, 2);
  assert.equal(await readFile(join(plan.target, 'Contents/Resources/app.asar'), 'utf8'), 'old version');
});

test('installer waits for its parent to exit and rejects invalid installation targets', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},100)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await waitForExit(child.pid!);
  assert.notEqual(child.exitCode, null);
  assert.throws(() => validatePlan({ platform: 'win32', parentPid: 0 } as InstallPlan));
});
