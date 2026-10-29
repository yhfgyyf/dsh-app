import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BrowserContext } from './sidebar-browser.tsx';
import { contentMatches, contentRoot, visibleContent, scrollToContentMatch } from './content-search.ts';
import { readSelectedText, selectedTextQuote, SELECTED_TEXT_SOURCE } from '../shared/selected-text.ts';
import type { SelectedText } from '../shared/selected-text.ts';
import { insertSelectionQuote } from './quote-actions.ts';
import './content-tools.css';

type Dispose = () => void;
type InputActions = { insertQuote(text: string): boolean };
interface ContentContext {
  slots: BrowserContext['slots'];
  effect(factory: () => Dispose, label?: string): void;
  get(name: string): any;
  sessions: { scope(id: string): unknown };
  conversation: { input: { for(scope: unknown): { insertQuote(text: string): boolean; focus(): void; notify(level: string, text: string): void } } };
  inputTriggers: { registerSource(source: object): Dispose };
  sidebarRight: { mounted: { getSnapshot(): string | undefined; subscribe(listener: () => void): Dispose } };
}
type Selection = { owner: string; root: HTMLElement; anchor: Node; value: SelectedText; x: number; y: number };
type Search = { owner: string; root: HTMLElement; revision: number };
type QuoteSurface = { readText(): string | null; clearSelection(): void; dismiss(): void };
type WaitForInput = (id: string, owner: string) => Promise<InputActions>;

function SelectionQuoteActions({ ctx, owner, sourceId, readText, clearSelection, dismiss, waitForInput }: QuoteSurface & {
  ctx: ContentContext; owner: string; sourceId: string; waitForInput: WaitForInput;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async (target: 'main' | 'side') => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const text = readText();
      if (text === null) { dismiss(); return; }
      await insertSelectionQuote(ctx, waitForInput, { target, owner, sourceId, text });
      // insertQuote establishes the editor caret; do not clear that new range.
      const anchor = document.getSelection()?.anchorNode;
      if (!(anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('[contenteditable="true"]')) clearSelection();
      dismiss();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      const scope = ctx.sessions.scope(owner);
      if (scope) ctx.conversation.input.for(scope).notify('error', message);
    } finally { pending.current = false; setBusy(false); }
  };
  return <div data-desktop-content-tools className="desktop-quote-actions" role="toolbar" aria-label="选中内容操作" onPointerDown={event => event.preventDefault()}>
    <button type="button" disabled={busy} onClick={() => { void add('main'); }}>引用文本到主会话</button>
    <button type="button" disabled={busy} onClick={() => { void add('side'); }}>在侧边聊天中提问</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}

/** Replace only the native Quote action renderer; keep its admission and placement. */
function NativeQuoteActions({ ctx, sessionId, useSession, waitForInput, ...surface }: QuoteSurface & {
  ctx: ContentContext; sessionId: string; waitForInput: WaitForInput;
  useSession<T>(select: (state: { removed: boolean; subagent: null | { address: { mode: string }; parentAvailable: boolean } }) => T): T;
}) {
  const owner = useSyncExternalStore(ctx.sidebarRight.mounted.subscribe, ctx.sidebarRight.mounted.getSnapshot);
  const enabled = useSession(state => !state.removed && (state.subagent === null || state.subagent.address.mode === 'continuable' && state.subagent.parentAvailable === true));
  useEffect(() => { if (!enabled) surface.dismiss(); }, [enabled, surface.dismiss]);
  if (!enabled || !owner) return null;
  return <SelectionQuoteActions {...surface} ctx={ctx} owner={owner} sourceId={sessionId} waitForInput={waitForInput} />;
}

function SelectedTextPreview({ value, close }: { value: SelectedText; close(): void }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = value.text.length > 480;
  const end = truncated && /[\uD800-\uDBFF]/.test(value.text[479]) ? 479 : 480;
  return <Modal open title="选中内容原文" closeLabel="关闭原文预览" onClose={close} className="desktop-selected-text-preview" footer={truncated &&
    <Button variant="outline" aria-expanded={expanded} onClick={() => setExpanded(current => !current)}>{expanded ? '收起全文' : '展开全文'}</Button>
  }>
    <p className="desktop-selected-text-source">来源：{value.source || '选中内容'}</p>
    <pre aria-label="原文内容">{expanded ? value.text : value.text.slice(0, end)}</pre>
    {truncated && !expanded && <p className="desktop-selected-text-source">仅显示原文开头片段，可展开查看全文。</p>}
  </Modal>;
}

function DraftBridge({ sessionId, inputActions, bind }: { sessionId: string; inputActions: InputActions; bind(id: string, actions: InputActions): Dispose }) {
  useLayoutEffect(() => bind(sessionId, inputActions), [sessionId, inputActions, bind]);
  return null;
}

function ContentFind({ root, revision, close, error }: Search & { close(): void; error(reason: unknown): void }) {
  const [id] = useState(() => crypto.randomUUID());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(() => contentMatches(root, ''));
  const [active, setActive] = useState(0);
  const [native, setNative] = useState({ matches: 0, active: 0 });
  const [failure, setFailure] = useState('');
  const browserId = root.querySelector<HTMLElement>('[data-desktop-browser-id]')?.dataset.desktopBrowserId;
  const officeFrame = root.querySelector<HTMLIFrameElement>('iframe[data-desktop-office-channel]');
  const remote = !!browserId || !!officeFrame;
  useEffect(() => { void window.dshDesktop?.showContentFind(id).catch(error); }, [id, revision]);
  useEffect(() => () => { void window.dshDesktop?.closeContentFind(id).catch(() => {}); }, [id]);
  useEffect(() => {
    setActive(0);
    setFailure('');
    if (officeFrame) {
      setNative({ matches: 0, active: 0 });
      const channel = officeFrame.dataset.desktopOfficeChannel;
      const send = () => officeFrame.contentWindow?.postMessage({ type: 'office-preview:find', channel, query }, '*');
      const receive = (event: MessageEvent) => {
        const value = event.data;
        if (event.source !== officeFrame.contentWindow || event.origin !== 'null' || value?.channel !== channel) return;
        if (value.type === 'office-preview:status' && value.state === 'ready') send();
        if (value.type === 'office-preview:find-result' && value.query === query && Number.isSafeInteger(value.matches) && Number.isSafeInteger(value.active)) setNative({ matches: value.matches, active: value.active });
      };
      window.addEventListener('message', receive); send();
      return () => window.removeEventListener('message', receive);
    }
    if (browserId) {
      setNative({ matches: 0, active: 0 });
      const unsubscribe = window.dshDesktop?.onBrowserFindResult(result => {
        if (result.id === browserId && result.query === query) setNative({ matches: result.matches, active: result.active });
      });
      void window.dshDesktop?.browserFind(browserId, query).catch(reason => setFailure(reason instanceof Error ? reason.message : String(reason)));
      return unsubscribe;
    }
    const refresh = () => setResults(contentMatches(root, query));
    refresh();
    let timer: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(records => {
      if (records.every(record => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[data-desktop-content-tools]'))) return;
      clearTimeout(timer); timer = setTimeout(refresh, 100);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'open'] });
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [root, query, browserId, officeFrame]);
  useEffect(() => {
    if (remote) return;
    CSS.highlights.set('desktop-content-results', new Highlight(...results.matches.map(match => match.range)));
    const match = results.matches[Math.min(active, Math.max(0, results.matches.length - 1))];
    if (match) {
      CSS.highlights.set('desktop-content-active', new Highlight(match.range));
      scrollToContentMatch(match.range, root);
    } else CSS.highlights.delete('desktop-content-active');
    return () => { CSS.highlights.delete('desktop-content-results'); CSS.highlights.delete('desktop-content-active'); };
  }, [root, results, active, remote]);
  useEffect(() => () => {
    if (browserId) void window.dshDesktop?.browserFind(browserId, '').catch(() => {});
    if (officeFrame) officeFrame.contentWindow?.postMessage({ type: 'office-preview:find', channel: officeFrame.dataset.desktopOfficeChannel, query: '' }, '*');
  }, [browserId, officeFrame]);
  const count = remote ? native.matches : results.matches.length;
  const ordinal = count ? remote ? native.active : Math.min(active + 1, count) : 0;
  const move = (forward: boolean) => {
    if (officeFrame) officeFrame.contentWindow?.postMessage({ type: 'office-preview:find', channel: officeFrame.dataset.desktopOfficeChannel, query, forward }, '*');
    else if (browserId) void window.dshDesktop?.browserFind(browserId, query, forward).catch(reason => setFailure(reason instanceof Error ? reason.message : String(reason)));
    else if (count) setActive(index => (index + (forward ? 1 : count - 1)) % count);
  };
  useEffect(() => window.dshDesktop?.onContentFindAction(action => {
    if (action.id !== id) return;
    if (action.type === 'query') setQuery(action.query);
    else if (action.type === 'navigate') move(action.forward);
    else close();
  }), [id, root, query, count, browserId, officeFrame, close]);
  useEffect(() => {
    void window.dshDesktop?.updateContentFind({ id, query, matches: count, active: ordinal, limited: !remote && results.limited, error: failure.slice(0, 4096) }).catch(error);
  }, [id, query, count, ordinal, remote, results.limited, failure, revision]);
  return null;
}

function ContentTools({ ctx, waitForInput, previews }: { ctx: ContentContext; waitForInput: WaitForInput; previews: SnapshotStore<SelectedText | null> }) {
  const preview = useSyncExternalStore(previews.subscribe, previews.getSnapshot);
  const [selection, setSelection] = useState<Selection>();
  const [search, setSearch] = useState<Search>();
  const lastRoot = useRef<HTMLElement>();
  const serial = useRef(0);
  const notify = (owner: string, reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const scope = ctx.sessions.scope(owner);
    if (scope) ctx.conversation.input.for(scope).notify('error', message);
  };
  useEffect(() => {
    const owner = () => ctx.sidebarRight.mounted.getSnapshot();
    const mainRoot = () => [...document.querySelectorAll<HTMLElement>('[data-conversation-content]')].find(root => root.dataset.conversationSession === owner() && !root.closest('[data-dockkit-content]'));
    const remember = (event: Event) => {
      if (!(event.target instanceof Element) || event.target.closest('[data-desktop-content-tools]')) return;
      lastRoot.current = contentRoot(event.target);
    };
    let frame = 0;
    const capture = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const selected = document.getSelection(), id = owner();
        const start = selected?.anchorNode?.parentElement, end = selected?.focusNode?.parentElement;
        const root = contentRoot(start ?? null);
        // Chat and /side use the native Quote interaction. This fallback only
        // supplies the same actions for document previews outside a Chat view.
        if (start?.closest('[data-conversation-content]')) { setSelection(undefined); return; }
        if (!id || !selected || selected.isCollapsed || !selected.rangeCount || !root || !end || contentRoot(end) !== root || !visibleContent(root)
          || start?.closest('input, textarea, [contenteditable], [data-desktop-content-tools]')) { setSelection(undefined); return; }
        const text = selected.toString();
        if (!text.trim()) { setSelection(undefined); return; }
        const rect = selected.getRangeAt(0).getBoundingClientRect();
        const viewport = root.getBoundingClientRect();
        if (rect.bottom < viewport.top || rect.top > viewport.bottom) { setSelection(undefined); return; }
        const source = root.querySelector('[data-side-chat-session]') ? '侧聊' : root.hasAttribute('data-dockkit-content') ? '文件 / 右侧面板' : '主对话';
        setSelection({ owner: id, root, anchor: selected.anchorNode!, value: { text, source }, x: Math.max(8, Math.min(rect.left, innerWidth - 330)), y: Math.max(8, rect.top - 44) });
      });
    };
    const find = (event: Event) => {
      const browserId = (event as CustomEvent<string | undefined>).detail;
      const browser = browserId ? [...document.querySelectorAll<HTMLElement>('[data-desktop-browser-id]')].find(element => element.dataset.desktopBrowserId === browserId) : undefined;
      const focused = contentRoot(document.activeElement);
      const root = browser ? contentRoot(browser) : (lastRoot.current && visibleContent(lastRoot.current) ? lastRoot.current : undefined) ?? focused ?? mainRoot();
      const id = owner();
      if (root && id && visibleContent(root)) { setSelection(undefined); setSearch({ owner: id, root, revision: ++serial.current }); }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelection(undefined);
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); find(new Event('dsh:find-content')); }
    };
    const unsubscribe = ctx.sidebarRight.mounted.subscribe(() => { lastRoot.current = undefined; setSelection(undefined); setSearch(undefined); previews.set(null); });
    const observer = new MutationObserver(() => {
      setSearch(current => current && visibleContent(current.root) ? current : undefined);
      setSelection(current => current && visibleContent(current.root) && current.anchor.isConnected ? current : undefined);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style'] });
    document.addEventListener('selectionchange', capture);
    document.addEventListener('scroll', capture, true);
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('focusin', remember, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('dsh:find-content', find);
    return () => {
      cancelAnimationFrame(frame); unsubscribe(); observer.disconnect();
      document.removeEventListener('selectionchange', capture); document.removeEventListener('pointerdown', remember, true); document.removeEventListener('focusin', remember, true); document.removeEventListener('keydown', key, true); window.removeEventListener('dsh:find-content', find);
      document.removeEventListener('scroll', capture, true);
    };
  }, [ctx, previews]);
  return <>
    {selection && <div className="desktop-file-quote-actions" style={{ left: selection.x, top: selection.y }}>
      <SelectionQuoteActions ctx={ctx} owner={selection.owner} sourceId={selection.owner} waitForInput={waitForInput}
        readText={() => {
          if (!visibleContent(selection.root) || !selection.anchor.isConnected) return null;
          return selection.value.text;
        }} clearSelection={() => selection.root.ownerDocument.getSelection()?.removeAllRanges()} dismiss={() => setSelection(undefined)} />
    </div>}
    {search && <ContentFind key={`${search.owner}:${search.root.dataset.dockkitContent ?? 'main'}`} {...search} error={reason => notify(search.owner, reason)} close={() => { setSearch(undefined); search.root.querySelector<HTMLElement>('[contenteditable="true"]')?.focus(); }} />}
    {preview && <SelectedTextPreview value={preview} close={() => previews.set(null)} />}
  </>;
}

export function installContentTools(ctx: ContentContext) {
  const inputs = new Map<string, InputActions>(), listeners = new Set<() => void>();
  const previews = createSnapshotStore<SelectedText | null>(null);
  let disposed = false;
  const changed = () => { for (const listener of listeners) listener(); };
  const bind = (id: string, actions: InputActions) => {
    inputs.set(id, actions); changed();
    return () => { if (inputs.get(id) === actions) inputs.delete(id); changed(); };
  };
  const waitForInput = (id: string, owner: string): Promise<InputActions> => new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); listeners.delete(check); unsubscribe(); observer.disconnect(); };
    const check = () => {
      if (disposed || ctx.sidebarRight.mounted.getSnapshot() !== owner) { stop(); reject(new Error('会话已切换，选中内容未加入其他会话。')); }
      else if (inputs.has(id) && [...document.querySelectorAll<HTMLElement>('[data-conversation-content]')].some(root =>
        root.dataset.conversationSession === id && root.querySelector<HTMLElement>('[contenteditable="true"]')?.checkVisibility({ checkVisibilityCSS: true })
      )) { stop(); resolve(inputs.get(id)!); }
    };
    // Existing /side tabs stay mounted while hidden. Wait for the tab switch to
    // commit before inserting/focusing, so subsequent typing reaches that draft.
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style'] });
    const timer = setTimeout(() => { stop(); reject(new Error('侧聊输入框未就绪，请稍后重试。')); }, 8000);
    const unsubscribe = ctx.sidebarRight.mounted.subscribe(check);
    listeners.add(check); check();
  });
  ctx.effect(() => () => { disposed = true; inputs.clear(); changed(); }, 'desktop: content tools lifetime');
  ctx.effect(() => ctx.inputTriggers.registerSource({
    name: SELECTED_TEXT_SOURCE, trigger: '@', candidates: async () => [], onPick: () => undefined,
    openReference: (_session: unknown, reference: { ref: string }) => {
      previews.set(readSelectedText(reference.ref));
      return true;
    },
    codec: { clipboardText: (ref: string) => selectedTextQuote(readSelectedText(ref)), serialize: async (ref: string) => selectedTextQuote(readSelectedText(ref)) },
  }), 'desktop: selected text references');
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'desktop-draft-bridge', inject: () => ({ bind }) }, DraftBridge));
  ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({ name: 'conversation.chat.text-interaction', key: 'quote', priority: -100, inject: () => ({ ctx, waitForInput }) }, NativeQuoteActions));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'desktop-content-tools', inject: () => ({ ctx, waitForInput, previews }) }, ContentTools));
}
