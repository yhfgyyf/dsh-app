import { isAbsolute, resolve } from 'node:path';
import { previewFileOf } from '../shared/sidebar-browser.ts';
import type { LocalOpenTarget } from '../shared/local-open.ts';

export const absolutePath = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0') && isAbsolute(value);

export function localTargetPath(target: LocalOpenTarget | undefined): string {
  if (!target || typeof target !== 'object') throw new Error('请先选择文件或文件夹。');
  if ('path' in target) {
    if (absolutePath(target.path)) return resolve(target.path);
  } else if (typeof target.address === 'string' && typeof target.sessionId === 'string') {
    const file = previewFileOf(target.address, target.sessionId);
    if (file && !file.relative && absolutePath(file.path)) return resolve(file.path);
    if (file?.relative && absolutePath(target.cwd)) return resolve(target.cwd, file.path);
  }
  throw new Error('无法定位此会话的本地文件。');
}
