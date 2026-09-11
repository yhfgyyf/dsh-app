import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePreviewText, documentExtension } from '../src/shared/document-preview.ts';

test('text previews decode UTF-8, BOM variants and Windows UTF-16/GBK bytes', () => {
  const text = 'Windows 中文\r\n第二行 <script>test</script>';
  for (const bytes of [Buffer.from(text), Buffer.from('\ufeff' + text)]) assert.deepEqual(decodePreviewText(bytes), { text, encoding: 'utf-8' });
  for (const bom of ['', '\ufeff']) {
    const le = Buffer.from(bom + text, 'utf16le');
    assert.deepEqual(decodePreviewText(le), { text, encoding: 'utf-16le' });
    assert.deepEqual(decodePreviewText(Buffer.from(le).swap16()), { text, encoding: 'utf-16be' });
  }
  assert.deepEqual(decodePreviewText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a])), { text: '中文\r\n', encoding: 'gb18030' });
  assert.deepEqual(decodePreviewText(Buffer.alloc(0)), { text: '', encoding: 'utf-8' });
});

test('text encodings can be selected explicitly and binary files are rejected', () => {
  assert.equal(decodePreviewText(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]), 'big5').text, '中文');
  assert.equal(decodePreviewText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'windows-1252').text, 'café');
  assert.throws(() => decodePreviewText(Buffer.from([0xff]), 'utf-8'), /编码/);
  assert.throws(() => decodePreviewText(Buffer.from([1, 2, 0, 3, 4, 5, 0, 6])), /二进制/);
});

test('document suffixes recognize encoded filenames and Windows paths', () => {
  assert.equal(documentExtension('dsh-resource://file/session/s1/%E6%96%87%E4%BB%B6%2ETXT'), 'txt');
  assert.equal(documentExtension('dsh-resource://file/session/s1/C%3A/Work/a.MP4'), 'mp4');
  assert.equal(documentExtension('dsh-resource://file/session/s1/no-extension'), '');
});
