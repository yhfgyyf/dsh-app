import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BrowserUseCredentials {
  load(): Promise<string | undefined>;
  save(token: string | undefined): Promise<void>;
}

type Cipher = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
};

export function parseExtensionToken(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string') throw new Error('浏览器连接令牌无效。');
  const token = value.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/, '');
  if (!/^[A-Za-z0-9_+/=-]{16,1024}$/.test(token)) throw new Error('请粘贴完整的浏览器扩展令牌。');
  return token;
}

/** A separate, OS-encrypted credential; never part of desktop.json or renderer state. */
export class BrowserUseCredentialsFile implements BrowserUseCredentials {
  readonly path: string;
  private directory: string;
  private cipher: Cipher;
  constructor(directory: string, cipher: Cipher) {
    this.directory = directory;
    this.cipher = cipher;
    this.path = join(directory, 'browser-use-credentials.json');
  }
  private available() {
    if (!this.cipher.isEncryptionAvailable() || (process.platform === 'linux' && this.cipher.getSelectedStorageBackend?.() === 'basic_text')) {
      throw new Error('系统加密存储不可用，无法保存自动连接令牌。');
    }
  }
  private async exists() {
    try {
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid credential file');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error('浏览器连接凭据无法安全读取，原文件已保留。');
    }
  }
  async load(): Promise<string | undefined> {
    if (!await this.exists()) return undefined;
    this.available();
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || typeof value.encryptedToken !== 'string') throw new Error('Invalid credential');
      return parseExtensionToken(this.cipher.decryptString(Buffer.from(value.encryptedToken, 'base64')));
    } catch { throw new Error('浏览器连接凭据无法解密，请重新保存令牌。'); }
  }
  async save(token: string | undefined): Promise<void> {
    const exists = await this.exists();
    if (token === undefined) {
      if (exists) await unlink(this.path);
      return;
    }
    token = parseExtensionToken(token)!;
    this.available();
    const temporary = join(this.directory, `.browser-use-${randomUUID()}.tmp`);
    let created = false;
    try {
      const contents = JSON.stringify({ version: 1, encryptedToken: this.cipher.encryptString(token).toString('base64') }) + '\n';
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(this.directory)).isDirectory()) throw new Error('Invalid credential directory');
      const handle = await open(temporary, 'wx', 0o600);
      created = true;
      try { await handle.writeFile(contents); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.path);
      created = false;
    } catch { throw new Error('浏览器连接凭据保存失败，原文件已保留。'); }
    finally { if (created) await unlink(temporary).catch(() => {}); }
  }
}
