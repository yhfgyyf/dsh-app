import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserContext } from './sidebar-browser.tsx';
import { decodePreviewText, documentExtension, MEDIA_TYPES, TEXT_ENCODINGS, TEXT_EXTENSIONS } from '../shared/document-preview.ts';
import type { TextEncoding } from '../shared/document-preview.ts';
import { WordDocument, SlidesDocument } from './office-preview.tsx';
import { SpreadsheetDocument } from './spreadsheet-preview.tsx';

export interface DocumentContext extends BrowserContext {
  documentPreviews: { register(definition: { id: string; extensions: string[]; title(): string; priority: 'extension'; loading: 'bytes-complete'; wrap: boolean }): () => void };
}
export interface DocumentProps {
  resourceAddress: string;
  content: { kind: 'bytes'; data: Uint8Array<ArrayBuffer> } | { kind: 'text'; text: string };
  wrap: boolean;
  useTabInfo?(): { tab: { visible: boolean; signal: AbortSignal; navigation: { revision: number; params?: { line?: unknown } } } };
}

// Tab signals survive viewer remounts and reloads; completed navigation must too.
const textNavigationRevisions = new WeakMap<AbortSignal, number>();

function TextDocument({ content, wrap, useTabInfo }: DocumentProps) {
  const tab = useTabInfo?.().tab;
  const requested = tab?.navigation.params?.line;
  const line = typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0 ? requested : undefined;
  const target = useRef<HTMLSpanElement>(null);
  const [encoding, setEncoding] = useState<TextEncoding>('auto');
  const decoded = useMemo<{ text?: string; encoding?: string; error?: string }>(() => {
    try { return content.kind === 'bytes' ? decodePreviewText(content.data, encoding) : { text: content.text, encoding: 'utf-8' }; }
    catch (error) { return { error: (error as Error).message }; }
  }, [content, encoding]);
  const parts = useMemo(() => {
    const text = decoded.text;
    if (!text || line === undefined) return;
    let start = 0;
    for (let number = 1; number < line; number++) {
      const newline = text.indexOf('\n', start);
      if (newline < 0 || newline === text.length - 1) return;
      start = newline + 1;
    }
    const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline + 1;
    // Keep large logs as text nodes, with only the requested line in an element.
    return { before: text.slice(0, start), target: text.slice(start, end), after: text.slice(end) };
  }, [decoded.text, line]);
  useEffect(() => {
    if (!tab || !tab.visible || tab.signal.aborted || decoded.text === undefined) return;
    const { signal, navigation: { revision } } = tab;
    if (textNavigationRevisions.get(signal) === revision) return;
    if (!parts) { textNavigationRevisions.set(signal, revision); return; }
    // Run after the owner restores its saved scroll position on mount/reload.
    const frame = requestAnimationFrame(() => {
      const element = target.current, scrollport = element?.closest<HTMLElement>('[data-textpreview-body]');
      if (signal.aborted || !element || !scrollport) return;
      scrollport.scrollTop = Math.max(0, scrollport.scrollTop + element.getBoundingClientRect().top - scrollport.getBoundingClientRect().top);
      textNavigationRevisions.set(signal, revision);
    });
    return () => cancelAnimationFrame(frame);
  }, [tab?.signal, tab?.visible, tab?.navigation.revision, decoded.text, parts]);
  return <section className="desktop-document" data-document-preview="text">
    <label className="desktop-document-options">文本编码 <select aria-label="文本编码" value={encoding} onChange={event => setEncoding(event.target.value as TextEncoding)}>
      {TEXT_ENCODINGS.map(value => <option key={value} value={value}>{value === 'auto' ? '自动检测' : value.toUpperCase()}</option>)}
    </select><span>{decoded.encoding?.toUpperCase()}</span></label>
    {decoded.error ? <p role="alert">{decoded.error}</p> : <pre style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}>{parts ? <>{parts.before}<span ref={target} data-textpreview-line={line} data-textpreview-target={line} style={{ background: 'var(--dsw-alias-interactive-bg-hover)' }}>{parts.target}</span>{parts.after}</> : decoded.text || '（空文件）'}</pre>}
  </section>;
}

function MediaDocument({ resourceAddress, content }: DocumentProps) {
  const type = MEDIA_TYPES[documentExtension(resourceAddress)];
  const data = content.kind === 'bytes' ? content.data : undefined;
  const [source, setSource] = useState<{ data: typeof data; url: string }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    setError(false);
    if (!data || !type) return;
    const url = URL.createObjectURL(new Blob([data], { type }));
    setSource({ data, url });
    return () => URL.revokeObjectURL(url);
  }, [data, type]);
  const url = source?.data === data ? source?.url : undefined;
  return <section className="desktop-document desktop-document-media" data-document-preview="media">
    {url && (type.startsWith('image/') ? <img src={url} alt="图片预览" onError={() => setError(true)} /> : type.startsWith('audio/') ? <audio key={url} src={url} controls preload="metadata" onError={() => setError(true)} /> : <video key={url} src={url} controls preload="metadata" onError={() => setError(true)} />)}
    {error && <p role="alert">当前系统不支持此文件的编码，或文件已损坏。可通过文件菜单在本地应用中打开。</p>}
  </section>;
}

function LegacyOfficeDocument({ resourceAddress }: DocumentProps) {
  const word = documentExtension(resourceAddress) === 'doc';
  return <section className="desktop-document" data-document-preview="unsupported-office">
    <p>此文件是旧版 {word ? 'DOC' : 'PPT'} 格式。请在 Word、PowerPoint 或 WPS 中另存为 {word ? 'DOCX' : 'PPTX'} 或 PDF，再在侧栏预览。</p>
    <p>也可以通过文件菜单直接在本地应用中打开原文件。</p>
  </section>;
}

export function installDocumentPreviews(ctx: DocumentContext): void {
  for (const [id, title, extensions, wrap, component] of [
    ['desktop-text', '文本（编码兼容）', TEXT_EXTENSIONS, true, TextDocument],
    ['desktop-media', '图片 / 音视频', Object.keys(MEDIA_TYPES), false, MediaDocument],
    ['desktop-word', 'Word 文档', ['docx', 'docm', 'dotx', 'dotm'], false, WordDocument],
    ['desktop-slides', 'PowerPoint 演示', ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx'], false, SlidesDocument],
    ['desktop-spreadsheet', '电子表格', ['xlsx', 'xls', 'xlsm', 'xlsb', 'xltx', 'xltm', 'ods', 'csv', 'tsv'], true, SpreadsheetDocument],
    ['desktop-legacy-office', '旧版 Office 格式', ['doc', 'ppt'], false, LegacyOfficeDocument],
  ] as const) {
    ctx.effect(() => ctx.documentPreviews.register({ id, title: () => title, extensions: [...extensions], priority: 'extension', loading: 'bytes-complete', wrap }), `${id}: metadata`);
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({ name: 'sidebar.right.tab.document', key: id }, component)), `${id}: body`);
  }
}
