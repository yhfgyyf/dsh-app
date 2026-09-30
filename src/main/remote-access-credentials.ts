import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultRemoteConfig, parseRemoteConfig, parseRemoteCredentials, parseLocalRemoteCredentials, type RemoteConfig, type RemoteCredentials, type LocalRemoteCredentials } from '../shared/remote-access.ts';

type Cipher = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?(): string };
export class RemoteCredentialsFile {
  readonly path: string;
  private directory: string;
  private cipher: Cipher;
  constructor(directory: string, cipher: Cipher) { this.directory = directory; this.cipher = cipher; this.path = join(directory, 'remote-access.json'); }
  available() { return this.cipher.isEncryptionAvailable() && this.cipher.getSelectedStorageBackend?.() !== 'basic_text'; }
  private async exists() {
    try { const stat = await lstat(this.path); if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('invalid'); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new Error('远程配置无法安全读取，原文件已保留。'); }
  }
  async load(): Promise<{ config: RemoteConfig; credentials?: RemoteCredentials; local?: LocalRemoteCredentials }> {
    if (!await this.exists()) return { config: defaultRemoteConfig() };
    const data = JSON.parse(await readFile(this.path, 'utf8'));
    if (![1, 2].includes(data.version)) throw new Error('远程配置版本无效。');
    const config = parseRemoteConfig({ ...data.config, ...(data.version === 1 ? { background: true } : {}) });
    if (!data.encrypted) return { config: { ...config, enabled: false } };
    if (!this.available()) throw new Error('系统密钥环不可用，无法恢复远程连接。');
    const saved = JSON.parse(this.cipher.decryptString(Buffer.from(data.encrypted, 'base64')));
    const credentials = data.version === 1 ? parseRemoteCredentials(saved) : saved.credentials ? parseRemoteCredentials(saved.credentials) : undefined;
    const local = data.version === 2 && saved.local ? parseLocalRemoteCredentials(saved.local) : undefined;
    if (credentials && credentials.relay !== config.relay) throw new Error('远程凭据与中继地址不匹配。');
    return { config, credentials, local };
  }
  async save(config: RemoteConfig, credentials?: RemoteCredentials, local?: LocalRemoteCredentials) {
    config = parseRemoteConfig(config); await this.exists();
    if ((credentials || local) && !config.sessionOnly && !this.available()) throw new Error('系统密钥环不可用，无法保存手机绑定。');
    if (credentials && credentials.relay !== config.relay) throw new Error('不能把原中继凭据用于其他地址。');
    const encrypted = (credentials || local) && !config.sessionOnly ? this.cipher.encryptString(JSON.stringify({
      ...(credentials ? { credentials: parseRemoteCredentials(credentials) } : {}), ...(local ? { local: parseLocalRemoteCredentials(local) } : {}),
    })).toString('base64') : undefined;
    const data = { version: 2, config: config.sessionOnly ? { ...config, enabled: false } : config, encrypted };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw new Error('远程配置目录无效。');
    const temp = join(this.directory, `.remote-${randomUUID()}.tmp`);
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(data) + '\n'); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(() => {}); }
  }
}
