import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSelectedText, selectedTextQuote, selectedTextReference, SELECTED_TEXT_SOURCE } from '../src/shared/selected-text.ts';

test('selected text reference survives persisted JSON and keeps exact text, including Unicode and markup', () => {
  const value = { text: '第一段 🙂\n<script>alert(1)</script>\n  code & 2 < 3', source: '主对话' };
  const reference = JSON.parse(JSON.stringify(selectedTextReference(value)));
  assert.equal(reference.source, SELECTED_TEXT_SOURCE);
  assert.deepEqual(readSelectedText(reference.ref), value);
  assert.equal(reference.clipboardText, '选中内容（主对话）：\n> 第一段 🙂\n> <script>alert(1)</script>\n>   code & 2 < 3\n\n');
});

test('malformed and empty selections fail without manufacturing or silently truncating a reference', () => {
  for (const value of [null, {}, { text: ' ', source: '' }, { text: 1, source: '' }, { text: 'x', source: 1 }, { text: 'x'.repeat(1_000_001), source: '' }]) {
    assert.throws(() => readSelectedText(JSON.stringify(value)));
  }
  assert.equal(selectedTextQuote({ text: 'a\r\nb\rc', source: 'a\nb' }), '选中内容（a b）：\n> a\n> b\n> c\n\n');
});
