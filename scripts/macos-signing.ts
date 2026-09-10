import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);
export function developerIdentity(requested: string | undefined, available: string) {
  if (!requested || requested === '-') throw new Error('正式 macOS 构建需要 DSH_MAC_SIGN_IDENTITY 指定有效的 Developer ID Application 证书；不会回退到 ad-hoc。');
  const identity = [...available.matchAll(/\b([A-Fa-f0-9]{40}) "(Developer ID Application: [^"\n]+ \(([A-Z0-9]{10})\))"/g)]
    .find(match => match[1].toLowerCase() === requested.toLowerCase() || match[2] === requested);
  if (!identity) throw new Error('指定的 Developer ID Application 证书和私钥不可用。请在构建机钥匙串中安装后重试；不会回退到 ad-hoc。');
  return { identity: identity[1], name: identity[2], teamId: identity[3] };
}

export async function macSigningIdentity(required: boolean) {
  const requested = process.env.DSH_MAC_SIGN_IDENTITY;
  const keychain = process.env.DSH_MAC_SIGN_KEYCHAIN;
  if (!required && !requested) return { identity: '-', name: 'ad-hoc', teamId: undefined, keychain: undefined };
  if (!requested) developerIdentity(requested, '');
  const { stdout } = await execute('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', ...(keychain ? [keychain] : [])]);
  return { ...developerIdentity(requested, stdout), keychain };
}

/** Only native code changes during signing; all other runtime bytes stay exact. */
export async function machOFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  const magic = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
  async function visit(relative: string) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const file = await open(join(root, path));
        try { const bytes = Buffer.alloc(4); await file.read(bytes, 0, 4, 0); if (magic.has(bytes.toString('hex'))) files.add(path); }
        finally { await file.close(); }
      }
    }
  }
  await visit('');
  return files;
}
