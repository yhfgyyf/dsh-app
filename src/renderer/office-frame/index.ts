import { renderAsync } from 'docx-preview';
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer';
import { verifyOfficeArchive, OFFICE_ZIP_LIMITS } from '../../shared/office-preview.ts';
import type { OfficeFormat } from '../../shared/office-preview.ts';

const channel = document.documentElement.dataset.channel!;
const parentOrigin = document.documentElement.dataset.parentOrigin!;
const container = document.getElementById('document')!;
const cancellation = new AbortController();
let viewer: PptxViewer | undefined;
let disposeWord: (() => void) | undefined;
let loaded = false, disposed = false, reportedBlocked = false;
const report = (state: string, extra: { message?: string; pages?: number } = {}) => {
  if (!disposed) parent.postMessage({ type: 'office-preview:status', channel, state, ...extra }, parentOrigin === 'null' ? '*' : parentOrigin);
};
const blocked = () => { if (!reportedBlocked) { reportedBlocked = true; report('blocked'); } };
const dispose = () => { disposed = true; cancellation.abort(); viewer?.destroy(); viewer = undefined; disposeWord?.(); container.replaceChildren(); };
addEventListener('pagehide', dispose, { once: true });
addEventListener('securitypolicyviolation', blocked);
document.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (link && !link.getAttribute('href')?.startsWith('#')) { event.preventDefault(); event.stopImmediatePropagation(); blocked(); }
}, true);
document.addEventListener('submit', event => { event.preventDefault(); blocked(); }, true);

function wordZoom() {
  const wrapper = container.querySelector<HTMLElement>('.docx-wrapper');
  if (!wrapper) return;
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:sticky;top:0;z-index:1000;padding:8px 12px;background:#fafafa;border-bottom:1px solid #ddd;font-size:12px';
  const label = document.createElement('label');
  label.textContent = '显示比例 ';
  const select = document.createElement('select');
  select.setAttribute('aria-label', '文档显示比例');
  for (const [value, text] of [['fit', '适应宽度'], ['actual', '100%']]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = text; select.append(option);
  }
  label.append(select); toolbar.append(label); container.before(toolbar);
  const resize = () => {
    wrapper.style.zoom = '1';
    const available = Math.max(1, document.documentElement.clientWidth - 16);
    wrapper.style.zoom = String(select.value === 'fit' ? Math.min(1, available / wrapper.offsetWidth) : 1);
    document.body.dataset.officeZoom = select.value;
  };
  select.addEventListener('change', resize);
  addEventListener('resize', resize);
  resize();
  disposeWord = () => { removeEventListener('resize', resize); toolbar.remove(); };
}

async function preview(data: ArrayBuffer, format: OfficeFormat) {
  try {
    await verifyOfficeArchive(new Uint8Array(data), cancellation.signal);
    document.body.dataset.format = format;
    let pages: number;
    if (format === 'docx') {
      await renderAsync(data, container, undefined, { renderAltChunks: false, useBase64URL: true, ignoreLastRenderedPageBreak: false, experimental: false });
      if (disposed) { container.replaceChildren(); return; }
      wordZoom();
      pages = container.querySelectorAll('section.docx').length;
    } else {
      viewer = new PptxViewer(container, { zipLimits: { ...RECOMMENDED_ZIP_LIMITS, ...OFFICE_ZIP_LIMITS }, pdfjs: false, lazySlides: true, lazyMedia: true, scrollContainer: document.scrollingElement as HTMLElement });
      await viewer.open(data, { signal: cancellation.signal, listOptions: { windowed: true, initialSlides: 4, batchSize: 4 } });
      pages = viewer.slideCount;
    }
    if (disposed) { container.replaceChildren(); return; }
    if (!pages) throw new Error('文档中没有可显示的页面。');
    report('ready', { pages });
  } catch (error) {
    if (disposed) return;
    viewer?.destroy(); viewer = undefined;
    disposeWord?.();
    container.replaceChildren();
    const reason = error instanceof Error ? error.message : '';
    report('error', { message: /预览限制|ZIP64|文件已损坏|没有可显示/.test(reason) ? reason : '文档已损坏、受密码保护，或包含不支持的内容。可在本地应用中打开。' });
  }
}

addEventListener('message', event => {
  const value = event.data;
  if (event.source !== parent || event.origin !== parentOrigin || value?.channel !== channel) return;
  if (value.type === 'office-preview:dispose') { dispose(); return; }
  if (disposed || loaded || value.type !== 'office-preview:load' || !(value.data instanceof ArrayBuffer) || !['docx', 'pptx'].includes(value.format)) return;
  loaded = true;
  void preview(value.data, value.format);
});
