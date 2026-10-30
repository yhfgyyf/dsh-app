export const SELECTED_TEXT_SOURCE = 'desktop-selected-text';
export type SelectedText = { text: string; source: string };

export function readSelectedText(ref: string): SelectedText {
  const value: unknown = JSON.parse(ref);
  if (!value || typeof value !== 'object' || !('text' in value) || !('source' in value)
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 1_000_000
    || typeof value.source !== 'string' || value.source.length > 512) throw new Error('选中内容无效或超过 100 万字符。');
  return { text: value.text, source: value.source };
}

/** The same self-contained text survives draft persistence, copying and sending. */
export function selectedTextQuote(value: SelectedText): string {
  const selected = readSelectedText(JSON.stringify(value));
  const source = selected.source.replace(/[\r\n]+/g, ' ');
  return `选中内容${source ? `（${source}）` : ''}：\n> ${selected.text.replace(/\r\n?/g, '\n').replaceAll('\n', '\n> ')}\n\n`;
}

export function selectedTextReference(value: SelectedText) {
  return { source: SELECTED_TEXT_SOURCE, ref: JSON.stringify(readSelectedText(JSON.stringify(value))), label: '选中内容', clipboardText: selectedTextQuote(value) };
}
