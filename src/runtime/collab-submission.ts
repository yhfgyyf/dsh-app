import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { record, textField, MAX_ATTACHMENT_BYTES } from '../../services/relay/src/collab-types.ts';
import type { CollabGeneratedFile, CollabSubmission } from '../shared/collab.ts';

export const COLLAB_ANSWER_FORMAT = `使用 GitHub Issue 风格的 Markdown：先直接回答结论，再按需要写步骤、实际验证及结果、限制。使用清晰的小标题、列表、表格、行内代码；多行代码使用带语言名称的围栏代码块。引用资料提供有说明文字的 HTTPS 链接，不编造链接或未执行的检查。附件在正文中说明文件名、用途和验证情况，不把本机绝对路径当成别人可访问的下载链接。
在当前工作目录写入 UTF-8 submission.json，结构为 {"body":"Markdown 正文","verification":"实际验证及结果；未验证就明确写未验证","limitations":"限制与未验证部分","files":["相对于当前工作目录的产物路径"]}。正文最多 49152 字符，验证最多 16000 字符，限制最多 8000 字符。files 只列本任务确实生成、需要共享的文件，最多 8 个，每个不超过 8 MiB，禁止绝对路径或目录外文件。无附件时写空数组；超过限制的文件仅在已有可访问下载地址时提供链接，不擅自上传到第三方。最后一条回答也应为可直接发布的 Markdown 正文。发布由协作空间处理，不要自行调用消息或上传接口。`;

export async function readGeneratedFile(cwd: string, path: string): Promise<Buffer> {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.includes('\0')) throw new Error('附件必须使用本次任务目录内的相对路径。');
  const root = await realpath(cwd), target = await realpath(resolve(root, path)), rel = relative(root, target);
  if (!rel || rel.startsWith('..' + '/') || rel === '..' || isAbsolute(rel)) throw new Error('附件超出了本次任务目录。');
  const info = await stat(target);
  if (!info.isFile() || info.size === 0 || info.size > MAX_ATTACHMENT_BYTES) throw new Error(`附件“${basename(path)}”必须为非空文件且不超过 8 MiB。`);
  const bytes = await readFile(target);
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('附件大小在读取时发生变化，请重新生成。');
  return bytes;
}

export async function checkedGeneratedFile(cwd: string, file: CollabGeneratedFile) {
  const bytes = await readGeneratedFile(cwd, file.path);
  if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`附件“${file.name}”在预览后发生变化，请重新生成后发布。`);
  return bytes;
}

export async function readSubmission(cwd: string, output: string): Promise<CollabSubmission> {
  let value: Record<string, unknown>;
  try {
    const source = await readGeneratedFile(cwd, 'submission.json');
    if (source.length > 256 * 1024) throw new Error('AI 生成的提交说明过大。');
    value = record(JSON.parse(source.toString('utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    value = { body: output, verification: '未单独提供验证说明，请以正文中的实际证据为准。', limitations: '', files: [] };
  }
  if (!Array.isArray(value.files) || value.files.length > 8 || value.files.some(p => typeof p !== 'string')) throw new Error('附件清单必须是最多 8 个相对路径。');
  if (new Set(value.files).size !== value.files.length) throw new Error('附件清单包含重复文件。');
  const body = textField(value.body, 49152), verification = textField(value.verification ?? '未提供单独验证说明。', 16000), limitations = textField(value.limitations ?? '', 8000, true);
  const files: CollabGeneratedFile[] = [];
  for (const path of value.files as string[]) {
    const bytes = await readGeneratedFile(cwd, path);
    files.push({ id: randomUUID(), path, name: basename(path), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), uploadId: randomUUID() });
  }
  return { body, verification, limitations, files };
}
