import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentProps } from './document-preview.tsx';
import { OFFICE_FILE_LIMIT, officeFrameDocument } from '../shared/office-preview.ts';
import type { OfficeFormat } from '../shared/office-preview.ts';

declare const __DSH_OFFICE_FRAME_SCRIPT__: string;

type PreviewStatus = { channel: string; state: 'loading' | 'ready' | 'error'; message?: string; pages?: number; blocked?: boolean };

function OfficeDocument({ resourceAddress, content, format }: DocumentProps & { format: OfficeFormat }) {
  const bytes = content.kind === 'bytes' ? content.data : undefined;
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<PreviewStatus>();
  const document = useMemo(() => {
    const channel = crypto.randomUUID();
    return { channel, html: officeFrameDocument(__DSH_OFFICE_FRAME_SCRIPT__, channel, crypto.randomUUID(), location.origin) };
  }, [bytes, resourceAddress, format, attempt]);
  const current: PreviewStatus = status?.channel === document.channel ? status : { channel: document.channel, state: 'loading' };
  const title = format === 'docx' ? 'Word 文档预览' : 'PowerPoint 演示预览';

  useEffect(() => {
    const channel = document.channel, target = frame.current?.contentWindow;
    if (!bytes || bytes.byteLength > OFFICE_FILE_LIMIT) {
      setStatus({ channel, state: 'error', message: !bytes ? '无法读取文档的二进制内容。' : '文件超过 32 MB 的预览限制。' });
      return;
    }
    let active = true, settled = false;
    const timeout = window.setTimeout(() => {
      if (!active || settled) return;
      settled = true;
      target?.postMessage({ type: 'office-preview:dispose', channel }, '*');
      setStatus({ channel, state: 'error', message: '预览处理超时。可以重试，或在本地应用中打开此文档。' });
    }, 45000);
    const receive = (event: MessageEvent) => {
      const value = event.data;
      if (!active || event.source !== target || event.origin !== 'null' || value?.type !== 'office-preview:status' || value.channel !== channel) return;
      if (value.state === 'blocked') {
        setStatus(previous => ({ ...(previous?.channel === channel ? previous : { channel, state: 'loading' }), blocked: true }));
      } else if (!settled && ['ready', 'error'].includes(value.state)) {
        settled = true;
        clearTimeout(timeout);
        setStatus(previous => ({ channel, state: value.state, blocked: previous?.channel === channel && previous.blocked,
          pages: Number.isInteger(value.pages) && value.pages > 0 ? value.pages : undefined,
          message: typeof value.message === 'string' ? value.message.slice(0, 300) : undefined }));
      }
    };
    window.addEventListener('message', receive);
    return () => {
      active = false;
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
      target?.postMessage({ type: 'office-preview:dispose', channel }, '*');
    };
  }, [document, bytes]);

  const load = () => {
    if (!bytes || bytes.byteLength > OFFICE_FILE_LIMIT) return;
    const copy = bytes.slice();
    frame.current?.contentWindow?.postMessage({ type: 'office-preview:load', channel: document.channel, format, data: copy.buffer }, '*', [copy.buffer]);
  };

  return <section data-office-preview={format} data-office-status={current.state} aria-label={title} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 320, minWidth: 0 }}>
    <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
      {current.state === 'loading' ? '正在准备文档预览…' : current.state === 'ready' ? `${current.pages ? `${current.pages} 页 · ` : ''}只读预览，排版可能与 Office 略有不同。` : '文档预览不可用。'}
      <span> 外部链接和联网资源已禁用。</span>
      {current.blocked && <span role="status"> 已阻止文档请求的外部内容。</span>}
    </div>
    {current.state === 'error' ? <div style={{ padding: 16 }}><p role="alert">{current.message || '文档已损坏、受密码保护，或包含不支持的内容。可在本地应用中打开。'}</p><button onClick={() => setAttempt(value => value + 1)}>重试预览</button></div>
      : <iframe key={document.channel} ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document.html} onLoad={load} style={{ flex: 1, width: '100%', minHeight: 280, border: 0, visibility: current.state === 'ready' ? 'visible' : 'hidden' }} />}
  </section>;
}

export function WordDocument(props: DocumentProps) { return <OfficeDocument {...props} format="docx" />; }
export function SlidesDocument(props: DocumentProps) { return <OfficeDocument {...props} format="pptx" />; }
