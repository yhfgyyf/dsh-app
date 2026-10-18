import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** This profile belongs to the current OS user; never follow a substituted credential file. */
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Profile directory must be owned by the current user.');
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let file;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('Invalid profile file; the original was preserved.');
    file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const current = await file.stat();
    if (process.getuid && current.uid !== process.getuid()) throw new Error('Profile file belongs to another user.');
    if (process.platform !== 'win32') await file.chmod(0o600);
    return JSON.parse(await file.readFile('utf8')) as T;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
  finally { await file?.close(); }
}

export async function writeJson(path: string, value: unknown) {
  await privateDirectory(dirname(path));
  try { if (!(await lstat(path)).isFile()) throw new Error('Refusing to replace an invalid profile file.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temp = join(dirname(path), '.' + randomUUID() + '.tmp');
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
