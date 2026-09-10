import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, FormEvent } from 'react';
import { externalWebUrl } from '../shared/desktop-api.ts';
import { BROWSER_TAB_ID, PREVIEW_TAB_ID, browserTitle, webAddress, webUrlOf } from '../shared/sidebar-browser.ts';
import type { BrowserState, BrowserTarget } from '../shared/sidebar-browser.ts';

type Disposer = () => void;
export interface BrowserContext {
  effect(factory: () => Disposer, label?: string): void;
  sidebarRight: {
    isExpanded(): boolean; toggleExpanded(): void;
    active(): { contentId: string } | undefined;
    openResource(address: string, options?: { kind?: string; params?: { source?: boolean } }): void;
  };
  sidebarRightTabs: { register(definition: { id: string; kind: string; patterns?: string[]; priority: 'extension'; title(address: string): string; guide?: { order: number; title(): string; description(): string }[] }): Disposer };
  slots: {
    inject(name: string, factory: () => Disposer): Disposer;
    register(options: { name: string; key?: string; id?: string; order?: number; priority?: number; inject?: (...args: any[]) => unknown }, component: ComponentType<any>): Disposer;
  };
}
interface TabProps {
  sessionId: string;
  useSessions<T>(selector: (state: { byId: Record<string, { cwd?: string } | undefined> }) => T): T;
  useTabInfo(): { tab: { id: string; kind: string; contentId: string; visible: boolean; signal: AbortSignal; navigation: { revision: number }; actions: { openResource(address: string, options?: { replaceTab?: boolean }): void } } };
  ctx: BrowserContext;
  retain(id: string, signal: AbortSignal): void;
}

function BrowserTab({ sessionId, useSessions, useTabInfo, ctx, retain }: TabProps) {
  const { tab } = useTabInfo();
  const id = `${sessionId}:${tab.id}`;
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd);
  const preview = tab.kind === 'preview';
  const target = useMemo<BrowserTarget | undefined>(() => {
    if (preview) return { kind: 'preview', address: tab.contentId, sessionId, cwd };
    const url = webUrlOf(tab.contentId);
    return url ? { kind: 'web', url } : undefined;
  }, [preview, tab.contentId, sessionId, cwd]);
  const [state, setState] = useState<BrowserState>();
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string>();
  const [opened, setOpened] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const api = window.dshDesktop;
    if (!api || !target || tab.signal.aborted) return;
    let current = true;
    setOpened(false); setError(undefined);
    retain(id, tab.signal);
    const receive = (next: BrowserState) => { if (current && next.id === id) setState(next); };
    const unsubscribe = api.onBrowserState(receive);
    void api.browserOpen(id, target, `${tab.contentId}:${tab.navigation.revision}`).then(next => {
      if (current) { receive(next); setOpened(true); }
    }).catch(reason => { if (current) setError(String(reason.message ?? reason)); });
    return () => { current = false; unsubscribe(); void api.browserBounds(id, null); };
  }, [id, target, tab.contentId, tab.navigation.revision, tab.signal, retain]);
  useEffect(() => { setAddress(state?.url ?? (target?.kind === 'web' ? target.url : '')); }, [state?.url, target]);

  useEffect(() => {
    const api = window.dshDesktop;
    if (!api || !opened || !tab.visible) { void api?.browserBounds(id, null); return; }
    let frame = 0, previous = '';
    const measure = () => {
      const element = viewport.current;
      let bounds: { x: number; y: number; width: number; height: number } | null = null;
      if (element?.isConnected) {
        const rect = element.getBoundingClientRect();
        // Native views sit above DOM content. Hide only when an overlay intersects this viewport.
        const obstructed = [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-modal="true"]')].some(node =>
          node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && [...node.getClientRects()].some(overlay =>
            overlay.width > 0 && overlay.height > 0 && overlay.left < rect.right && overlay.right > rect.left && overlay.top < rect.bottom && overlay.bottom > rect.top));
        const uncovered = [[.5, .5], [.01, .01], [.99, .01], [.01, .99], [.99, .99]].every(([x, y]) => {
          const top = document.elementFromPoint(rect.x + rect.width * x, rect.y + rect.height * y);
          return top && element.contains(top);
        });
        if (!obstructed && uncovered && rect.width > 0 && rect.height > 0) bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      const signature = JSON.stringify(bounds) + window.devicePixelRatio;
      if (signature !== previous) { previous = signature; void api.browserBounds(id, bounds); }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => { cancelAnimationFrame(frame); void api.browserBounds(id, null); };
  }, [id, opened, tab.visible]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const url = externalWebUrl(address.includes('://') ? address : `https://${address}`);
    if (!url) { setError('请输入有效的网址。'); return; }
    setError(undefined);
    if (target) void window.dshDesktop?.browserNavigate(id, url).catch(reason => setError(reason.message));
    else tab.actions.openResource(webAddress(url), { replaceTab: true });
  };
  return <section className="desktop-browser" aria-label={preview ? '文件预览' : '侧栏浏览器'}>
    <div className="desktop-browser-toolbar">
      <button title="后退" aria-label="后退" disabled={!state?.canGoBack} onClick={() => { void window.dshDesktop?.browserAction(id, 'back'); }}>←</button>
      <button title="前进" aria-label="前进" disabled={!state?.canGoForward} onClick={() => { void window.dshDesktop?.browserAction(id, 'forward'); }}>→</button>
      <button title={state?.loading ? '停止加载' : '刷新'} aria-label={state?.loading ? '停止加载' : '刷新'} disabled={!opened} onClick={() => { setError(undefined); void window.dshDesktop?.browserAction(id, state?.loading ? 'stop' : 'reload'); }}>{state?.loading ? '×' : '↻'}</button>
      <form onSubmit={navigate}><input aria-label={preview ? '预览文件路径' : '网址'} placeholder="输入网址" value={address} readOnly={preview} onChange={event => setAddress(event.target.value)} /></form>
      {preview ? <button onClick={() => ctx.sidebarRight.openResource(tab.contentId, { kind: 'text', params: { source: true } })}>源码</button> : <button title="在外部浏览器打开" aria-label="在外部浏览器打开" disabled={!externalWebUrl(state?.url)} onClick={() => { if (state) void window.dshDesktop?.openExternal(state.url); }}>↗</button>}
    </div>
    {(error || state?.error) && <p className="desktop-browser-error" role="alert">{error || state?.error}</p>}
    <div className="desktop-browser-viewport" ref={viewport}>
      {!target && <p>在上方输入网址，或点击会话中的网页链接。</p>}
    </div>
  </section>;
}

export function installSidebarBrowser(ctx: BrowserContext): void {
  const lifetimes = new Map<string, { signal: AbortSignal; close: Disposer }>();
  const retain = (id: string, signal: AbortSignal) => {
    if (lifetimes.get(id)?.signal === signal) return;
    lifetimes.get(id)?.close();
    const close = () => { signal.removeEventListener('abort', close); lifetimes.delete(id); void window.dshDesktop?.browserClose(id); };
    lifetimes.set(id, { signal, close });
    signal.addEventListener('abort', close, { once: true });
  };
  ctx.effect(() => () => { for (const { close } of lifetimes.values()) close(); }, 'desktop: browser lifetime');
  ctx.effect(() => window.dshDesktop?.onOpenLink(url => {
    try { ctx.sidebarRight.openResource(webAddress(url)); }
    catch (error) {
      if (error instanceof Error && error.message === 'sidebarRight: no session surface is mounted') void window.dshDesktop?.openExternal(url);
      else throw error;
    }
  }) ?? (() => {}), 'desktop: open links in sidebar');
  for (const definition of [
    { id: BROWSER_TAB_ID, kind: 'browser', patterns: ['dsh-resource://web/**'], priority: 'extension' as const, title: browserTitle, guide: [{ order: 20, title: () => '浏览器', description: () => '在右侧浏览网页' }] },
    { id: PREVIEW_TAB_ID, kind: 'preview', patterns: ['*.html', '*.htm', '*.svg', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.pdf'], priority: 'extension' as const, title: browserTitle },
  ]) {
    ctx.effect(() => ctx.sidebarRightTabs.register(definition), `desktop: ${definition.kind} tab`);
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id, inject: () => ({ ctx, retain }) }, BrowserTab)), `desktop: ${definition.kind} body`);
  }
}
