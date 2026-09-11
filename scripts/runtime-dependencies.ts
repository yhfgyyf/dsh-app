import { lstat, realpath, rename, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function linkRuntimeDependencies(target: string, link: string) {
  const expected = await realpath(target);
  const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing) {
    const current = await realpath(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing.isSymbolicLink() && current === expected) return;
    await rename(link, `${link}-before-${Date.now()}-${randomUUID()}`);
  }
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
