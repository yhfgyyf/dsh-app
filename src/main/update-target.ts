import { access, lstat, mkdir, mkdtemp, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareVersions } from '../shared/updates.ts';

const run = promisify(execFile);

/** A translocated app is read-only. Stage its verified copy in the user's Applications folder before updating it. */
export async function macUpdateTarget(current: string, userApplications: string | undefined, version: string): Promise<string> {
  if (basename(current) !== 'DSH Desktop.app') throw new Error('应用安装路径无效。');
  if (!current.split('/').includes('AppTranslocation') && await access(dirname(current), constants.W_OK).then(() => true, () => false)) return current;
  if (!userApplications) throw new Error('请将 DSH Desktop 移到“应用程序”目录后重新打开，再重试安装。');
  await mkdir(userApplications, { recursive: true });
  await access(userApplications, constants.W_OK).catch(() => { throw new Error('用户“应用程序”目录不可写，请将 DSH Desktop 移到可写目录后重新打开。'); });
  const target = join(userApplications, 'DSH Desktop.app');
  const existing = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('用户“应用程序”目录已有其他同名文件，请先检查该文件。');
    const info = join(target, 'Contents/Info.plist');
    const get = async (key: string) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', info])).stdout.trim();
    if (await get('CFBundleIdentifier') !== 'io.dsh.desktop' || compareVersions(await get('CFBundleShortVersionString'), version) >= 0) throw new Error('用户“应用程序”目录已有其他应用或相同、新版本，请从该目录打开 DSH Desktop。');
    return target;
  }
  const directory = await mkdtemp(join(userApplications, '.DSH-Desktop-move-'));
  const staged = join(directory, 'DSH Desktop.app');
  await run('/usr/bin/ditto', [current, staged]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
  await rename(staged, target);
  return target;
}
