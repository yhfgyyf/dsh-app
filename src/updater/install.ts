import { rename, stat, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';

// Electron presents .asar files as virtual directories; installation checks need disk bytes.
export const physicalFs: typeof nodeFs = process.versions.electron ? createRequire(process.execPath)('original-fs') : nodeFs;

export type InstallPlan = {
  platform: 'darwin' | 'win32';
  parentPid: number;
  corePid?: number;
  target: string;
  payload: string;
  backup: string;
  version: string;
  sha256: string;
  result: string;
};

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of physicalFs.createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${basename(command)} 安装失败 (${code})。`)));
  });
}

export function validatePlan(plan: InstallPlan) {
  if (!['darwin', 'win32'].includes(plan.platform) || !Number.isSafeInteger(plan.parentPid) || plan.parentPid < 1 || !/^[0-9a-f]{64}$/.test(plan.sha256) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(plan.version)) throw new Error('更新安装计划无效。');
  if (plan.corePid !== undefined && (!Number.isSafeInteger(plan.corePid) || plan.corePid < 1)) throw new Error('更新进程信息无效。');
  for (const path of [plan.target, plan.payload, plan.backup, plan.result]) if (!isAbsolute(path)) throw new Error('更新安装路径无效。');
  if (plan.target === plan.payload || plan.target === plan.backup || dirname(plan.target) !== dirname(plan.backup) || (plan.platform === 'darwin' && (basename(plan.target) !== 'DSH Desktop.app' || basename(plan.payload) !== 'DSH Desktop.app'))) throw new Error('更新目标无效。');
}

export async function waitForExit(pid: number) {
  const deadline = Date.now() + 60000;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
    if (Date.now() > deadline) throw new Error('应用尚未退出，已取消安装。');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function moveWindowsDirectory(from: string, to: string) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

/** The helper runs outside the installation directory, after the app and owned core exit. */
export async function installUpdate(plan: InstallPlan, launch = launchApp) {
  validatePlan(plan);
  const hashPath = plan.platform === 'darwin' ? join(plan.payload, 'Contents/Resources/app.asar') : plan.payload;
  if (await fileSha256(hashPath) !== plan.sha256) throw new Error('待安装文件已变化，已取消更新。');
  try { await stat(plan.backup); throw new Error('旧版备份路径已存在。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let backedUp = false;
  try {
    if (plan.platform === 'darwin') {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', plan.payload]);
      await rename(plan.target, plan.backup);
      backedUp = true;
      await rename(plan.payload, plan.target);
    } else {
      // Mapped DLLs can outlive the old main process. Keep that entire directory;
      // never delete or overwrite its files during installation or rollback.
      await moveWindowsDirectory(plan.target, plan.backup);
      backedUp = true;
      await run(plan.payload, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOCLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS', `/DIR=${plan.target}`, `/LOG=${join(dirname(plan.result), 'inno-update.log')}`]);
    }
    await writeFile(plan.result, JSON.stringify({ status: 'installed', version: plan.version, backup: plan.backup, time: new Date().toISOString() }), { mode: 0o600 });
    await launch(plan);
  } catch (error) {
    let failure = error;
    let restored = !backedUp;
    if (backedUp) {
      try {
        if (plan.platform === 'darwin') {
          // Keep the failed new bundle for inspection; restore the original atomically.
          try { await stat(plan.target); await rename(plan.target, plan.payload); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
          await rename(plan.backup, plan.target);
        } else {
          try { await stat(plan.target); await moveWindowsDirectory(plan.target, plan.backup + '-failed'); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
          await moveWindowsDirectory(plan.backup, plan.target);
        }
        restored = true;
      } catch (rollbackError) {
        failure = new Error(`${error instanceof Error ? error.message : String(error)} 回退未完成：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}；旧版备份保留在 ${plan.backup}。`);
      }
    }
    await writeFile(plan.result, JSON.stringify({ status: 'error', error: failure instanceof Error ? failure.message : String(failure), backup: plan.backup }), { mode: 0o600 }).catch(() => {});
    if (restored) await launch(plan).catch(() => {});
    throw failure;
  }
}

async function launchApp(plan: InstallPlan) {
  const executable = plan.platform === 'darwin' ? join(plan.target, 'Contents/MacOS/DSH Desktop') : join(plan.target, 'DSH Desktop.exe');
  const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false, cwd: plan.target });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}
