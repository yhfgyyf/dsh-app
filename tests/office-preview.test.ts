import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { crc32, deflateRawSync } from 'node:zlib';
import { checkOfficeArchive, OFFICE_ZIP_LIMITS, officeFrameDocument, verifyOfficeArchive } from '../src/shared/office-preview.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/document-preview/${name}`, import.meta.url)));
const directory = (bytes: Uint8Array) => new DataView(bytes.buffer).getUint32(bytes.length - 6, true);

test('Office preflight accepts real Word and PowerPoint documents with embedded pictures', () => {
  for (const name of ['sample.docx', 'sample.pptx']) assert.doesNotThrow(() => checkOfficeArchive(fixture(name)));
});

test('Office streaming validation checks the actual contents of real document archives', async () => {
  for (const name of ['sample.docx', 'sample.pptx']) await verifyOfficeArchive(fixture(name));
  await assert.rejects(verifyOfficeArchive(fixture('sample.docx'), AbortSignal.abort()), { name: 'AbortError' });
});

function forgedArchive(content: Uint8Array, declared: number, streaming = false): Uint8Array<ArrayBuffer> {
  const compressed = deflateRawSync(content), name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(name.length, 28);
  const descriptor = streaming ? Buffer.alloc(16) : Buffer.alloc(0);
  if (streaming) {
    local.writeUInt16LE(8, 6); local.fill(0, 14, 26); central.writeUInt16LE(8, 8);
    descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc32(content), 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(declared, 12);
  }
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length + descriptor.length, 16);
  return new Uint8Array(Buffer.concat([local, name, compressed, descriptor, central, name, end]));
}

test('Office streaming validation rejects understated ZIP sizes before a document parser sees them', async () => {
  const bomb = forgedArchive(new Uint8Array(33 * 1024 * 1024).fill(65), 1);
  assert.ok(bomb.byteLength < 40 * 1024);
  assert.doesNotThrow(() => checkOfficeArchive(bomb), 'Directory-only budgets cannot detect the forged size');
  await assert.rejects(verifyOfficeArchive(bomb), /内部文件长度不一致/);
  await assert.rejects(verifyOfficeArchive(forgedArchive(new TextEncoder().encode('real content'), 1)), /内部文件长度不一致/);
});

test('Office validation accepts data descriptors but rejects conflicting local and directory metadata', async () => {
  const content = new TextEncoder().encode('a small document with actual streaming ZIP headers');
  await verifyOfficeArchive(forgedArchive(content, content.length, true));
  const conflict = forgedArchive(content, content.length), view = new DataView(conflict.buffer), central = directory(conflict);
  view.setUint16(central + 10, 0, true);
  view.setUint32(central + 24, view.getUint32(central + 20, true), true);
  await assert.rejects(verifyOfficeArchive(conflict), /文件已损坏/);
  const zip64 = forgedArchive(content, content.length);
  const localNameLength = new DataView(zip64.buffer).getUint16(26, true), split = 30 + localNameLength;
  const extra = new Uint8Array([1, 0, 0, 0]);
  const expanded = new Uint8Array(zip64.length + extra.length);
  expanded.set(zip64.subarray(0, split)); expanded.set(extra, split); expanded.set(zip64.subarray(split), split + extra.length);
  const expandedView = new DataView(expanded.buffer);
  expandedView.setUint16(28, extra.length, true);
  expandedView.setUint32(expanded.length - 6, directory(zip64) + extra.length, true);
  await assert.rejects(verifyOfficeArchive(expanded), /ZIP64/);
});

test('Office preflight rejects corrupt, encrypted and oversized entries before rendering', () => {
  const docx = fixture('sample.docx');
  assert.throws(() => checkOfficeArchive(docx.slice(0, docx.length - 1)), /文件已损坏/);
  const encrypted = docx.slice();
  new DataView(encrypted.buffer).setUint16(directory(encrypted) + 8, 1, true);
  assert.throws(() => checkOfficeArchive(encrypted), /密码保护/);
  const oversized = docx.slice();
  const oversizedView = new DataView(oversized.buffer), oversizedDirectory = directory(oversized);
  oversizedView.setUint32(oversizedDirectory + 24, OFFICE_ZIP_LIMITS.maxEntryUncompressedBytes + 1, true);
  oversizedView.setUint32(oversizedView.getUint32(oversizedDirectory + 42, true) + 22, OFFICE_ZIP_LIMITS.maxEntryUncompressedBytes + 1, true);
  assert.throws(() => checkOfficeArchive(oversized), /解压后的内容过大/);
  const outside = docx.slice();
  new DataView(outside.buffer).setUint32(directory(outside) + 42, 0xfffffffe, true);
  assert.throws(() => checkOfficeArchive(outside), /文件已损坏/);
});

test('Office frame authorizes only its bundled script and keeps script-like document text inert', () => {
  const literal = '</script><script>alert(1)</script><!--';
  const html = officeFrameDocument(`globalThis.value=${JSON.stringify(literal)};`, 'channel-1', 'nonce-1', 'https://localhost:1234');
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  assert.match(html, /script-src 'nonce-nonce-1'/);
  for (const directive of ["connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(html.includes(directive));
  assert.ok(!html.includes('unsafe-eval'));
  const script = html.match(/<script nonce="nonce-1">([\s\S]*)<\/script>/)![1];
  const context: Record<string, unknown> = {};
  runInNewContext(script, context);
  assert.equal(context.value, literal);
  assert.throws(() => officeFrameDocument('', 'channel-1', '" onclick="bad', 'https://localhost'), /identity/);
});
