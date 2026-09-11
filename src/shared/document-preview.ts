export const TEXT_ENCODINGS = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'big5', 'windows-1252'] as const;
export type TextEncoding = typeof TEXT_ENCODINGS[number];
export const TEXT_EXTENSIONS = ['txt', 'text', 'log', 'ini', 'cfg', 'conf', 'config', 'properties', 'env', 'srt', 'vtt', 'ass', 'sub'];
export const MEDIA_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};

export function documentExtension(address: string): string {
  try {
    const path = decodeURIComponent(new URL(address).pathname).replaceAll('\\', '/');
    return path.slice(path.lastIndexOf('/') + 1).split('.').slice(1).at(-1)?.toLowerCase() ?? '';
  } catch { return ''; }
}

/** Preview decoding does not change the filesystem's strict UTF-8 editing contract. */
export function decodePreviewText(bytes: Uint8Array, requested: TextEncoding = 'auto'): { text: string; encoding: string } {
  let encoding: string = requested;
  if (encoding === 'auto') {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    else {
      // BOM-less UTF-16 commonly contains ASCII line endings or spaces in one byte lane.
      const sample = bytes.subarray(0, 4096);
      let even = 0, odd = 0;
      for (let i = 0; i < sample.length; i++) if (sample[i] === 0) {
        const paired = sample[i ^ 1];
        if (paired === 9 || paired === 10 || paired === 13 || (paired >= 32 && paired <= 126)) { if (i % 2) odd++; else even++; }
      }
      if (bytes.length % 2 === 0 && odd >= 2 && odd > sample.length / 8 && even === 0) encoding = 'utf-16le';
      else if (bytes.length % 2 === 0 && even >= 2 && even > sample.length / 8 && odd === 0) encoding = 'utf-16be';
      else {
        encoding = 'utf-8';
        try { new TextDecoder(encoding, { fatal: true }).decode(bytes); }
        catch {
          encoding = 'gb18030';
          try { new TextDecoder(encoding, { fatal: true }).decode(bytes); }
          catch { encoding = 'windows-1252'; }
        }
      }
    }
  }
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('无法按此编码读取，请尝试其他文本编码。'); }
  const controls = text.match(/[\x00-\x08\x0e-\x1f]/g)?.length ?? 0;
  if (text.includes('\0') || controls > Math.max(2, text.length / 100)) throw new Error('文件包含二进制内容，无法作为文本预览。');
  return { text, encoding };
}
