import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RemoteCredentialsFile } from '../main/remote-access-credentials.ts';
import { defaultRemoteConfig, relayOrigin } from '../shared/remote-access.ts';

export type RelayProfile = { id: string; name: string; relay: string; createdAt: number; legacy?: boolean; archivedAt?: number };
export type RelayProfiles = { version: 1; activeId: string; profiles: RelayProfile[] };
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
export async function privateFolder(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('中继配置目录无法安全读取，原文件已保留。');
  if (process.platform !== 'win32') await chmod(path, 0o700);
}
export async function readPrivateJson<T>(path: string, fallback: T): Promise<T> {
  let file;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('中继配置文件无效，原文件已保留。');
    file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const current = await file.stat();
    if (process.getuid && current.uid !== process.getuid()) throw new Error('中继配置不属于当前用户。');
    if (process.platform !== 'win32') await file.chmod(0o600);
    return JSON.parse(await file.readFile('utf8')) as T;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
  finally { await file?.close(); }
}
export async function writePrivateJson(path: string, value: unknown) {
  await privateFolder(dirname(path));
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

// DPAPI binds the vault key to the Windows login; key material is passed through stdin, never argv.
export function windowsProtect(value: Buffer, decrypt = false): Buffer {
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  try {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return Buffer.from(execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { input: value.toString('base64'), encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim(), 'base64');
  } catch { throw new Error('Windows 当前用户加密存储不可用，未保存凭据。'); }
}

export class RelayProfileStore {
  readonly root: string;
  readonly home: string;
  data: RelayProfiles = { version: 1, activeId: '', profiles: [] };
  private key?: Buffer;
  constructor(home: string) { this.home = home; this.root = join(home, 'collaboration-relays'); }
  async restore() {
    await privateFolder(this.root);
    this.data = this.validate(await readPrivateJson(join(this.root, 'profiles.json'), this.data));
  }
  private validate(value: RelayProfiles): RelayProfiles {
    if (!value || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 128 || typeof value.activeId !== 'string') throw new Error('中继配置列表无效，原文件已保留。');
    const ids = new Set<string>();
    for (const profile of value.profiles) {
      if (!validId(profile.id) || ids.has(profile.id) || !Number.isSafeInteger(profile.createdAt) || (profile.legacy !== undefined && profile.legacy !== true) || (profile.archivedAt !== undefined && !Number.isSafeInteger(profile.archivedAt))) throw new Error('中继配置记录无效。');
      this.name(profile.name); if (profile.relay) relayOrigin(profile.relay); ids.add(profile.id);
    }
    if (value.activeId && !value.profiles.some(p => p.id === value.activeId && !p.archivedAt)) throw new Error('当前中继配置不存在。');
    if (value.profiles.filter(p => p.legacy).length > 1) throw new Error('原始协作记录不能属于多套中继。');
    return value;
  }
  name(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('中继名称须为 1–80 个字符。'); return value.trim(); }
  get(id: string) { if (!validId(id)) throw new Error('中继配置编号无效。'); const p = this.data.profiles.find(p => p.id === id && !p.archivedAt); if (!p) throw new Error('中继配置不存在。'); return p; }
  directory(id: string) { if (!validId(id)) throw new Error('中继配置编号无效。'); return join(this.root, 'profiles', id); }
  collaborationHome(profile: RelayProfile) { return profile.legacy ? this.home : this.directory(profile.id); }
  async save(value: RelayProfiles) { this.validate(value); await writePrivateJson(join(this.root, 'profiles.json'), value); this.data = value; }
  async credentials(id: string) {
    if (!this.key) {
      const path = join(this.root, 'vault-key.json');
      let saved = await readPrivateJson<{ version: number; kind: string; key: string } | null>(path, null);
      if (!saved) {
        const raw = randomBytes(32), kind = process.platform === 'win32' ? 'dpapi' : 'private-file';
        const key = kind === 'dpapi' ? windowsProtect(raw) : raw;
        const initial = { version: 1, kind, key: key.toString('base64') };
        // Never replace another activation's key, including after a interrupted first run.
        let file;
        try { file = await open(path, 'wx', 0o600); await file.writeFile(JSON.stringify(initial)); await file.sync(); saved = initial; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; saved = await readPrivateJson(path, null); }
        finally { await file?.close(); }
      }
      if (!saved || saved.version !== 1 || saved.kind !== (process.platform === 'win32' ? 'dpapi' : 'private-file') || typeof saved.key !== 'string' || saved.key.length > 4096) throw new Error('中继加密密钥无效，原文件已保留。');
      const raw = Buffer.from(saved.key, 'base64');
      this.key = saved.kind === 'dpapi' ? windowsProtect(raw, true) : raw;
      if (this.key.length !== 32) { this.key = undefined; throw new Error('中继加密密钥无效，原文件已保留。'); }
    }
    const key = this.key;
    await privateFolder(this.directory(id));
    return new RemoteCredentialsFile(this.directory(id), {
      isEncryptionAvailable: () => true,
      encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
      decryptString(value) { if (value.length < 28) throw new Error('中继凭据密文无效。'); const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8'); },
    });
  }
  async create(name: string, relay: string) {
    const profile: RelayProfile = { id: randomUUID(), name: this.name(name), relay: relayOrigin(relay), createdAt: Date.now() };
    await (await this.credentials(profile.id)).save({ ...defaultRemoteConfig(), relay: profile.relay, name: profile.name });
    await this.save({ ...this.data, profiles: [...this.data.profiles, profile] });
    return profile;
  }
}
