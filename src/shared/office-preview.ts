export type OfficeFormat = 'docx' | 'pptx';
export const OFFICE_FILE_LIMIT = 32 * 1024 * 1024;
export const OFFICE_ZIP_LIMITS = { maxEntries: 4000, maxEntryUncompressedBytes: 32 * 1024 * 1024, maxTotalUncompressedBytes: 256 * 1024 * 1024 };

/** Reject oversized ZIP directories before reading their compressed entries. */
export function checkOfficeArchive(bytes: Uint8Array): { offset: number; compressed: number; expanded: number; method: number }[] {
  if (bytes.byteLength > OFFICE_FILE_LIMIT) throw new Error('文件超过 32 MB 的预览限制。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => new Error('文件已损坏、受密码保护，或不是受支持的 Office 文档。');
  const checkExtra = (start: number, size: number) => {
    const end = start + size;
    for (let offset = start; offset < end;) {
      if (offset + 4 > end) throw invalid();
      if (view.getUint16(offset, true) === 1) throw new Error('此 ZIP64 文档暂不支持预览，请在本地应用中打开。');
      offset += 4 + view.getUint16(offset + 2, true);
      if (offset > end) throw invalid();
    }
  };
  if (bytes.byteLength < 22 || view.getUint32(0, true) !== 0x04034b50) throw invalid();
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) { end = offset; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw invalid();
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new Error('此 ZIP64 文档暂不支持预览，请在本地应用中打开。');
  if (count === 0 || view.getUint16(end + 8, true) !== count || start + size !== end) throw invalid();
  if (count > OFFICE_ZIP_LIMITS.maxEntries) throw new Error('文档内部文件过多，超过预览限制。');
  let offset = start, total = 0;
  const entries = [];
  const localRanges = [];
  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalid();
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), expanded = view.getUint32(offset + 24, true);
    const local = view.getUint32(offset + 42, true);
    if ((flags & 1) !== 0 || ![0, 8].includes(method) || local + 30 > start || view.getUint32(local, true) !== 0x04034b50) throw invalid();
    const nameSize = view.getUint16(offset + 28, true), extraSize = view.getUint16(offset + 30, true);
    const next = offset + 46 + nameSize + extraSize + view.getUint16(offset + 32, true);
    if (next > end || view.getUint16(offset + 34, true) !== 0) throw invalid();
    checkExtra(offset + 46 + nameSize, extraSize);
    const localNameSize = view.getUint16(local + 26, true), localExtraSize = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameSize + localExtraSize;
    if (dataStart + compressed > start) throw invalid();
    checkExtra(local + 30 + localNameSize, localExtraSize);
    if (view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method || localNameSize !== nameSize) throw invalid();
    for (let index = 0; index < nameSize; index++) if (bytes[local + 30 + index] !== bytes[offset + 46 + index]) throw invalid();
    const checksum = view.getUint32(offset + 16, true), descriptor = (flags & 8) !== 0;
    for (const [at, expected] of [[14, checksum], [18, compressed], [22, expanded]]) {
      const actual = view.getUint32(local + at, true);
      if (actual !== expected && (!descriptor || actual !== 0)) throw invalid();
    }
    let localEnd = dataStart + compressed;
    if (descriptor) {
      if (localEnd + 12 > start) throw invalid();
      if (view.getUint32(localEnd, true) === 0x08074b50) localEnd += 4;
      if (localEnd + 12 > start || view.getUint32(localEnd, true) !== checksum || view.getUint32(localEnd + 4, true) !== compressed || view.getUint32(localEnd + 8, true) !== expanded) throw invalid();
      localEnd += 12;
    }
    total += expanded;
    if (expanded > OFFICE_ZIP_LIMITS.maxEntryUncompressedBytes || total > OFFICE_ZIP_LIMITS.maxTotalUncompressedBytes) throw new Error('文档解压后的内容过大，超过预览限制。');
    entries.push({ offset: dataStart, compressed, expanded, method });
    localRanges.push({ start: local, end: localEnd });
    offset = next;
  }
  if (offset !== end) throw invalid();
  // Some readers trust local headers while others trust the directory: validate both views.
  localRanges.sort((left, right) => left.start - right.start);
  let expected = 0;
  for (const range of localRanges) { if (range.start !== expected) throw invalid(); expected = range.end; }
  if (expected !== start) throw invalid();
  return entries;
}

/** Check actual output in bounded chunks; ZIP size fields alone are not trustworthy. */
export async function verifyOfficeArchive(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<void> {
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('Preview aborted', 'AbortError'); };
  checkAbort();
  const entries = checkOfficeArchive(bytes);
  let total = 0;
  for (const entry of entries) {
    checkAbort();
    if (entry.method === 0) {
      if (entry.compressed !== entry.expanded) throw new Error('文件已损坏：内部文件长度不一致。');
      total += entry.compressed;
      continue;
    }
    const stream = new Blob([bytes.subarray(entry.offset, entry.offset + entry.compressed)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    let expanded = 0;
    try {
      while (true) {
        checkAbort();
        const next = await reader.read();
        checkAbort();
        if (next.done) break;
        expanded += next.value.byteLength;
        total += next.value.byteLength;
        if (expanded > OFFICE_ZIP_LIMITS.maxEntryUncompressedBytes || total > OFFICE_ZIP_LIMITS.maxTotalUncompressedBytes) throw new Error('文档解压后的内容过大，超过预览限制。');
        if (expanded > entry.expanded) throw new Error('文件已损坏：内部文件长度不一致。');
      }
      if (expanded !== entry.expanded) throw new Error('文件已损坏：内部文件长度不一致。');
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }
}

/** Only the bundled renderer receives script permission; the frame has an opaque origin. */
export function officeFrameDocument(script: string, channel: string, nonce: string, parentOrigin: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(channel) || !/^[a-zA-Z0-9_-]+$/.test(nonce)) throw new Error('Office preview identity is invalid.');
  const escapedOrigin = parentOrigin.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!);
  const safeScript = script.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return `<!doctype html><html lang="zh-CN" data-channel="${channel}" data-parent-origin="${escapedOrigin}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;background:#eee;color:#222;font:14px system-ui,sans-serif}body{overflow:auto}#document{min-height:100vh;box-sizing:border-box}body[data-format="docx"] #document{padding:8px}body[data-format="docx"] .docx-wrapper{width:fit-content;min-width:100%;box-sizing:border-box;padding:12px}body[data-format="pptx"] #document{padding:12px}a{cursor:default}img{max-width:100%}</style></head><body><div id="document"></div><script nonce="${nonce}">${safeScript}</script></body></html>`;
}
