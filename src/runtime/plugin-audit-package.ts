import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { PackageReviewMaterials } from '../shared/plugin-security.ts';

const REGISTRY = 'https://registry.npmjs.org';
const ARCHIVE_LIMIT = 10 * 1024 * 1024;
const EXPANDED_LIMIT = 32 * 1024 * 1024;
const MATERIAL_LIMIT = 128 * 1024;
const FILE_LIMIT = 16 * 1024;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
export class PackageInspectionError extends Error {}
function fail(message: string): never { throw new PackageInspectionError(message); }
function record(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}
function parseSpec(spec: string): { name: string; selector: string } {
  if (typeof spec !== 'string' || spec.length > 320) fail('插件地址无效。');
  const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([0-9A-Za-z][0-9A-Za-z.+-]*))?$/.exec(spec.trim());
  if (!match || match[1].length > 214) fail('自动源码检查目前支持公共 npm 包名或精确版本；Git、本地路径及版本范围尚未检查。');
  return { name: match[1], selector: match[2] ?? 'latest' };
}
async function bytes(url: string, limit: number, signal: AbortSignal, fetcher: Fetcher): Promise<Buffer> {
  signal.throwIfAborted();
  const response = await fetcher(url, { signal, redirect: 'error', headers: { accept: '*/*' } });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    fail('无法读取安装包或响应超出检查大小限制。');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) { await reader.cancel(); fail('安装包超过检查大小限制。'); }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
function octal(buffer: Buffer): number {
  const value = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) fail('安装包 tar 数值字段无效。');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) fail('安装包 tar 数值超出限制。');
  return number;
}
function field(buffer: Buffer): string { return buffer.toString('utf8').replace(/\0.*$/, ''); }
function safePath(path: string, directory = false): string {
  if (path.startsWith('./')) path = path.slice(2);
  if (directory) path = path.replace(/\/$/, '');
  if (!path.startsWith('package/') && !(directory && path === 'package')) fail('安装包包含 package 目录外的文件。');
  const relative = path.replace(/^package\/?/, '');
  if (relative.length > 1024 || /[\\:\u0000-\u001f\u007f]/.test(relative)
    || relative.split('/').some(part => part === '..' || part === '.' || (!part && relative !== ''))) fail('安装包包含不受支持的路径。');
  if (!directory && !relative) fail('安装包文件路径为空。');
  return relative;
}
function pax(buffer: Buffer): Record<string, string> {
  const result: Record<string, string> = Object.create(null); let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space < 0 || space - offset > 8) fail('安装包 PAX 头无效。');
    const digits = buffer.subarray(offset, space).toString('ascii');
    const length = Number(digits);
    if (!/^\d+$/.test(digits) || length <= space - offset + 1 || offset + length > buffer.length || buffer[offset + length - 1] !== 10) fail('安装包 PAX 长度无效。');
    const line = buffer.subarray(space + 1, offset + length - 1).toString('utf8');
    const equal = line.indexOf('=');
    if (equal <= 0) fail('安装包 PAX 属性无效。');
    const key = line.slice(0, equal);
    if (key in result) fail('安装包 PAX 属性重复。');
    if (/sparse/i.test(key) || key === 'size' || key === 'linkpath') fail('安装包含不受支持的扩展文件类型。');
    result[key] = line.slice(equal + 1); offset += length;
  }
  return result;
}

/** Inspect bytes in memory only. No filesystem extraction, imports or lifecycle execution. */
export function readNpmArchive(archive: Buffer): { files: Map<string, Buffer>; expandedBytes: number } {
  let data: Buffer;
  try { data = gunzipSync(archive, { maxOutputLength: EXPANDED_LIMIT }); }
  catch { return fail('安装包无法解压，或展开后超过 32 MiB 检查上限。'); }
  const files = new Map<string, Buffer>(); let offset = 0; let entries = 0;
  let attributes: Record<string, string> | undefined;
  let longName: string | undefined;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (attributes || longName || !data.subarray(offset).every(byte => byte === 0)) fail('安装包 tar 结束标记无效。');
      return { files, expandedBytes: data.length };
    }
    if (++entries > 4000) fail('安装包文件数量超过检查上限。');
    const checksum = octal(header.subarray(148, 156));
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== sum) fail('安装包 tar 头校验失败。');
    const size = octal(header.subarray(124, 136));
    const end = offset + 512 + size;
    if (end > data.length) fail('安装包 tar 文件内容不完整。');
    const body = data.subarray(offset + 512, end);
    const type = String.fromCharCode(header[156]);
    const prefix = field(header.subarray(345, 500));
    const name = field(header.subarray(0, 100));
    if (type === 'x') {
      if (attributes || size > 16384) fail('安装包 PAX 头过大或重复。');
      attributes = pax(body);
    } else if (type === 'L') {
      if (longName || size > 2048) fail('安装包长路径头无效。');
      longName = field(body).replace(/\n$/, '');
    } else {
      if (!['0', '\0', '5'].includes(type)) fail('安装包包含链接、设备或不受支持的文件类型，未完成检查。');
      const path = safePath(attributes?.path ?? longName ?? (prefix ? `${prefix}/${name}` : name), type === '5');
      attributes = undefined; longName = undefined;
      if (type !== '5') {
        if (files.has(path)) fail('安装包包含重复文件路径。');
        files.set(path, body);
      }
    }
    offset = Math.ceil(end / 512) * 512;
  }
  return fail('安装包 tar 缺少结束标记。');
}
function strings(value: unknown): Record<string, string> {
  const source = record(value) ?? {};
  if (Object.keys(source).length > 512) fail('安装包依赖声明过多。');
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key.slice(0, 214), value.slice(0, 2048)]));
}
export async function inspectNpmPackage(spec: string, callerSignal: AbortSignal, options: { fetch?: Fetcher; timeoutMs?: number; onArchive?: (archive: Buffer) => void } = {}): Promise<PackageReviewMaterials> {
  const { name, selector } = parseSpec(spec);
  const timer = AbortSignal.timeout(options.timeoutMs ?? 25000);
  const signal = AbortSignal.any([callerSignal, timer]);
  const fetcher = options.fetch ?? fetch;
  let manifest: Json;
  try {
    const metadata = JSON.parse((await bytes(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(selector)}`, 1024 * 1024, signal, fetcher)).toString('utf8'));
    manifest = record(metadata) ?? fail('npm 插件信息无效。');
  } catch (error) {
    if (error instanceof PackageInspectionError) throw error;
    return fail('无法读取 npm 插件信息，未完成检查。');
  }
  const version = manifest.version;
  if (manifest.name !== name || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    || (/^\d+\.\d+\.\d+/.test(selector) && version !== selector)) fail('npm 返回的包名或版本与请求不符。');
  const dist = record(manifest.dist);
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity.split(/\s+/).find(value => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) : undefined;
  if (!integrity || Buffer.from(integrity.slice(7), 'base64').length !== 64) fail('该版本缺少可验证的 SHA-512 安装包摘要，未完成检查。');
  let url: URL;
  try { url = new URL(String(dist?.tarball)); } catch { return fail('npm 安装包地址无效。'); }
  if (url.origin !== REGISTRY || url.username || url.password || url.search || url.hash) fail('安装包不来自公共 npm registry，未完成检查。');
  let archive: Buffer;
  try { archive = await bytes(url.href, ARCHIVE_LIMIT, signal, fetcher); }
  catch (error) { if (error instanceof PackageInspectionError) throw error; return fail('下载审查材料失败或超时，未完成检查。'); }
  if (!timingSafeEqual(createHash('sha512').update(archive).digest(), Buffer.from(integrity.slice(7), 'base64'))) fail('安装包摘要校验失败，不能确认它是所请求的版本。');
  const { files: archiveFiles, expandedBytes } = readNpmArchive(archive);
  let pkg: Json;
  try { pkg = record(JSON.parse(archiveFiles.get('package.json')?.toString('utf8') ?? '')) ?? fail('package.json 无效。'); }
  catch { return fail('安装包缺少有效的 package.json。'); }
  if (pkg.name !== name || pkg.version !== version) fail('安装包中的包名或版本与 registry 不一致。');
  const patch = record(record(pkg.dsh)?.bundle)?.patch;
  if (typeof patch !== 'string' || !archiveFiles.has(safePath('package/' + patch.replace(/^\.\//, '')))) fail('安装包缺少声明的 DSH bundle 文件。');
  const priority = (path: string) => path === 'package.json' ? 0 : path === patch.replace(/^\.\//, '') ? 1 : /(?:^|\/)(?:index|main|plugin|runtime|install)\.[cm]?[jt]sx?$/.test(path) ? 2 : /\.[cm]?[jt]sx?$/.test(path) ? 3 : 4;
  const candidates = [...archiveFiles].filter(([path, body]) => /\.(?:[cm]?[jt]sx?|json|ya?ml|md|sh|ps1|cmd|bat)$/i.test(path) && !body.subarray(0, FILE_LIMIT).includes(0)).sort((a, b) => priority(a[0]) - priority(b[0]) || a[0].localeCompare(b[0]));
  const files: PackageReviewMaterials['files'] = [];
  let reviewed = 0;
  for (const [path, data] of candidates) {
    if (files.length >= 30 || reviewed >= MATERIAL_LIMIT) break;
    const selected = data.subarray(0, Math.min(FILE_LIMIT, MATERIAL_LIMIT - reviewed));
    files.push({ path, content: selected.toString('utf8'), ...(selected.length < data.length ? { truncated: true } : {}) });
    reviewed += selected.length;
  }
  const omitted = archiveFiles.size - files.length;
  const truncated = omitted > 0 || files.some(file => file.truncated === true);
  const repository = typeof record(pkg.repository)?.url === 'string' ? record(pkg.repository)!.url as string : typeof pkg.repository === 'string' ? pkg.repository : undefined;
  signal.throwIfAborted();
  options.onArchive?.(archive);
  return {
    name, version, spec: `${name}@${version}`, integrity, sha256: createHash('sha256').update(archive).digest('hex'),
    ...(repository ? { repository: repository.slice(0, 2048) } : {}), files,
    facts: { scripts: strings(pkg.scripts), dependencies: strings(pkg.dependencies), optionalDependencies: strings(pkg.optionalDependencies), peerDependencies: strings(pkg.peerDependencies) },
    scope: { filesTotal: archiveFiles.size, filesReviewed: files.length, bytesReviewed: reviewed, archiveBytes: archive.length, expandedBytes, omittedFiles: omitted, truncated, dependencies: 'manifest-only' },
    limitations: [
      '仅检查该版本安装包中的可读文件；没有运行插件，也没有在沙箱中测试行为。',
      '依赖仅审查声明，未下载或审计传递依赖，未查询已知漏洞数据库。',
      ...(truncated ? [`材料受大小和文件数限制；省略 ${omitted} 个文件，部分文件可能截断，不能代表完整源码审计。`] : []),
    ],
  };
}
