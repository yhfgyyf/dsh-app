import { deflateSync } from 'node:zlib';

const digits: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
  '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010',
  '8': '111101111101111', '9': '111101111001111', '+': '000010111010000',
};
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const value of body) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** A small red number overlay; generated without adding an image dependency. */
export function notificationBadgePng(count: number): Buffer {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Invalid badge count');
  const size = 32, stride = size * 4 + 1, pixels = Buffer.alloc(stride * size);
  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => pixels.set([r, g, b, a], y * stride + 1 + x * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const alpha = Math.round(255 * Math.max(0, Math.min(1, 16 - Math.hypot(x - 15.5, y - 15.5))));
    put(x, y, 248, 60, 60, alpha);
  }
  const text = count > 99 ? '99+' : String(count), scale = text.length === 1 ? 4 : text.length === 2 ? 3 : 2;
  const left = Math.floor((size - (text.length * 4 - 1) * scale) / 2), top = Math.floor((size - 5 * scale) / 2);
  for (const [index, digit] of [...text].entries()) for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) {
    if (digits[digit][row * 3 + col] !== '1') continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) put(left + (index * 4 + col) * scale + x, top + row * scale + y, 255, 255, 255, 255);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
