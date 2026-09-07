import { mkdir, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultPreferences, parsePreferences } from '../shared/config.ts';
import type { DesktopPreferences } from '../shared/config.ts';

export class PreferencesError extends Error {
  constructor() {
    super('桌面配置无法安全读取或保存，原文件已保留。');
    this.name = 'PreferencesError';
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Owns only desktop.json inside Electron's dedicated application-data directory. */
export class PreferencesFile {
  readonly path: string;
  private directory: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, 'desktop.json');
  }

  async load(): Promise<DesktopPreferences> {
    try {
      await this.assertRegularFile();
      return parsePreferences(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (isMissing(error)) return defaultPreferences();
      throw new PreferencesError();
    }
  }

  save(value: DesktopPreferences): Promise<void> {
    // Snapshot at call time so a subsequent caller mutation cannot change queued writes.
    const contents = JSON.stringify(parsePreferences(value), null, 2) + '\n';
    const write = this.writes.then(() => this.write(contents));
    this.writes = write.catch(() => {});
    return write;
  }

  private async assertRegularFile(): Promise<void> {
    const stat = await lstat(this.path);
    if (!stat.isFile()) throw new PreferencesError();
  }

  private async write(contents: string): Promise<void> {
    const temporary = join(this.directory, `.desktop-${randomUUID()}.tmp`);
    let created = false;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(this.directory)).isDirectory()) throw new PreferencesError();
      try {
        // Do not overwrite an unreadable/corrupt file with fresh defaults.
        await this.assertRegularFile();
        parsePreferences(JSON.parse(await readFile(this.path, 'utf8')));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const handle = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      created = false;
    } catch {
      throw new PreferencesError();
    } finally {
      if (created) await unlink(temporary).catch(() => {});
    }
  }
}
