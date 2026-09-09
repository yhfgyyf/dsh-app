import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileSha256, installUpdate, run, validatePlan, waitForExit, type InstallPlan } from '../src/updater/install.ts';
import { prepareMacUpdate } from '../src/main/updates.ts';
import { macUpdateTarget } from '../src/main/update-target.ts';

const mac = { skip: process.platform !== 'darwin' };
const windows = { skip: process.platform !== 'win32' };

test('Windows installer failure restores and relaunches the old app while its DLL is still mapped', windows, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-locked-'));
  const target = join(directory, 'DSH Desktop');
  await mkdir(target);
  const dll = join(target, 'd3dcompiler_47.dll');
  await cp(join(process.env.SystemRoot!, 'System32/d3dcompiler_47.dll'), dll);
  const hash = await fileSha256(dll);
  const script = join(directory, 'hold-dll.ps1');
  await writeFile(script, `Add-Type -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadLibrary(string path);' -Name Native -Namespace Fixture\n$module = [Fixture.Native]::LoadLibrary('${dll.replaceAll("'", "''")}')\nif ($module -eq [IntPtr]::Zero) { exit 1 }\n[Console]::WriteLine('ready')\n[Console]::ReadLine() | Out-Null\n`);
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DLL holder did not start')), 15000);
      holder.once('error', error => { clearTimeout(timer); reject(error); });
      holder.once('exit', code => { clearTimeout(timer); reject(new Error(`DLL holder exited: ${code}`)); });
      holder.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve(); } });
    });
    const plan: InstallPlan = { platform: 'win32', parentPid: process.pid, target, payload: process.execPath, backup: join(directory, 'previous-app'), version: '0.1.2', sha256: await fileSha256(process.execPath), result: join(directory, 'result.json') };
    let launched = false;
    // Node deliberately rejects Inno Setup arguments, after the backup is made.
    await assert.rejects(installUpdate(plan, async () => { launched = true; }), /node\.exe 安装失败/);
    assert.equal(launched, true, 'A failed update must relaunch the restored app');
    assert.equal(await fileSha256(dll), hash, 'The mapped DLL must remain byte-identical');
    assert.equal(JSON.parse(await readFile(plan.result, 'utf8')).status, 'error');
  } finally { holder.stdin.end('\n'); await waitForExit(holder.pid!); }
});

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

test('a read-only translocated app updates through a writable copy, preserving its source and rollback backup', mac, async () => {
  const { directory, plan } = await fixture();
  const parent = join(directory, 'AppTranslocation/id/d');
  const current = join(parent, 'DSH Desktop.app');
  await cp(plan.target, current, { recursive: true });
  await chmod(parent, 0o555);
  try {
    await assert.rejects(access(parent, constants.W_OK));
    const applications = join(directory, 'User Home/Applications');
    const target = await macUpdateTarget(current, applications, '0.1.3');
    assert.equal(target, join(applications, 'DSH Desktop.app'));
    assert.equal(await macUpdateTarget(target, applications, '0.1.3'), target);
    const backup = join(applications, 'previous.app');
    await installUpdate({ ...plan, target, backup }, async () => {});
    assert.equal(await readFile(join(target, 'Contents/Resources/app.asar'), 'utf8'), 'new version');
    for (const previous of [current, backup]) assert.equal(await readFile(join(previous, 'Contents/Resources/app.asar'), 'utf8'), 'old version');
  } finally { await chmod(parent, 0o755); }
});

test('macOS relocation refuses a same-version app or a symlink without replacing it', mac, async () => {
  const { directory, plan } = await fixture();
  const current = join(directory, 'AppTranslocation/id/d/DSH Desktop.app');
  await cp(plan.target, current, { recursive: true });
  const applications = join(directory, 'Applications');
  await mkdir(applications);
  const target = join(applications, 'DSH Desktop.app');
  await symlink(plan.target, target);
  await assert.rejects(macUpdateTarget(current, applications, '0.1.3'), /同名文件/);
  await assert.rejects(macUpdateTarget(current, join(directory, 'installed'), '0.1.2'), /相同、新版本/);
  assert.equal(await readFile(join(plan.target, 'Contents/Resources/app.asar'), 'utf8'), 'old version');
});

test('installer waits for its parent to exit and rejects invalid installation targets', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},100)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await waitForExit(child.pid!);
  assert.notEqual(child.exitCode, null);
  assert.throws(() => validatePlan({ platform: 'win32', parentPid: 0 } as InstallPlan));
});
