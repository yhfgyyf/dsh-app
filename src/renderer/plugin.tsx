import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DesktopCommand, DesktopInfo } from '../shared/desktop-api.ts';
import { installSidebarBrowser } from './sidebar-browser.tsx';
import type { BrowserContext } from './sidebar-browser.tsx';
import { UpdateIcon, UpdateScheduleSettings } from './updates.tsx';
import { installLocalOpen } from './local-open.tsx';
import { ComputerControl, ComputerSettings } from './computer-use.tsx';
import { installDocumentPreviews } from './document-preview.tsx';
import type { DocumentContext } from './document-preview.tsx';

type Disposer = () => void;
type ThemeSnapshot = { active: { colorScheme: 'light' | 'dark' } };
type StateSource = { subscribe(listener: () => void): Disposer; getSnapshot(): string };

// The narrow, verified public faces consumed from the installed DSH runtime.
interface DesktopContext extends BrowserContext, DocumentContext {
  effect(factory: () => Disposer, label?: string): void;
  on(event: 'theme/change', listener: (snapshot: ThemeSnapshot) => void): Disposer;
  get(name: 'uiWorkspace'): { startSession(): void };
  get(name: 'connection'): { state: StateSource; reconnect(): void };
  layout: { toggleSidebar(): void };
  theme: {
    getTheme(): ThemeSnapshot;
    overrideTokens(source: string, values: Record<string, { light: string; dark: string }>): Disposer;
  };
}

export const name = 'dsh-desktop-shell';
export const inject = ['slots', 'theme', 'layout', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace', 'connection', 'documentPreviews'];

const palette: Record<string, [string, string]> = {
  '--dsw-alias-bg-base': ['#ffffff', '#181818'],
  '--dsw-alias-bg-layer-1': ['#f7f7f7', '#202020'],
  '--dsw-alias-bg-layer-2': ['#ffffff', '#242424'],
  '--dsw-alias-bg-layer-3': ['#f1f1f1', '#2c2c2c'],
  '--dsw-alias-label-primary': ['#242424', '#ededed'],
  '--dsw-alias-label-secondary': ['#696969', '#acacac'],
  '--dsw-alias-label-tertiary': ['#858585', '#8b8b8b'],
  '--dsw-alias-border-l2': ['#e2e2e2', '#3a3a3a'],
  '--dsw-alias-border-l3': ['#e9e9e9', '#333333'],
  '--dsw-alias-border-l4': ['#d7d7d7', '#484848'],
  '--dsw-alias-interactive-bg-hover': ['#eaeaea', '#303030'],
  '--dsw-alias-interactive-bg-active': ['#e3e3e3', '#383838'],
  '--dsw-specific-sidebar-fill': ['#f6f6f6', '#202020'],
  '--dsw-specific-sidebar-nav-item-active': ['#e8e8e8', '#343434'],
  '--dsw-specific-sidebar-nav-item-hover': ['#ededed', '#2b2b2b'],
  '--dsw-specific-bubble': ['#f3f3f3', '#2a2a2a'],
  '--dsw-alias-button-elevated-fill': ['#ffffff', '#2b2b2b'],
  '--dsw-alias-button-floating-fill': ['#ffffff', '#2b2b2b'],
  '--dsw-alias-button-floating-hover': ['#efefef', '#363636'],
  '--ds-font-family': ['-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'],
  '--dsw-font-family': ['-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'],
  '--ds-font-family-code': ['"SFMono-Regular", Consolas, monospace', '"SFMono-Regular", Consolas, monospace'],
};

function Icon({ kind }: { kind: 'panel' | 'plus' | 'connect' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    {kind === 'plus' ? <path d="M12 5v14M5 12h14" /> : kind === 'panel' ? <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></> : <><rect x="3" y="4" width="18" height="13" rx="3" /><path d="M8 21h8m-4-4v4" /></>}
  </svg>;
}

function TitleBar({ state, reconnect }: { state: StateSource; reconnect: () => void }) {
  const status = useSyncExternalStore(state.subscribe, state.getSnapshot);
  const [title, setTitle] = useState(document.title);
  useEffect(() => {
    const observer = new MutationObserver(() => setTitle(document.title));
    const node = document.querySelector('title');
    if (node) observer.observe(node, { subtree: true, childList: true, characterData: true });

    return () => observer.disconnect();
  }, []);
  return <header className="desktop-titlebar" aria-label="DSH 桌面标题栏">
    <span className="desktop-title">{title.replace(/\s*[·|—-]\s*DSH.*$/, '') || 'DSH Desktop'}</span>
    <div className="desktop-title-actions">
      <UpdateIcon />
      <ComputerControl />
      <span className="desktop-status" role="status" title={status === 'connected' ? '已连接本机 DSH' : 'DSH 连接中断'}><i data-connected={status === 'connected'} />{status === 'connected' ? '本机' : status === 'connecting' ? '连接中' : '离线'}</span>
      {status !== 'connected' && <button onClick={reconnect}>重连</button>}
    </div>
  </header>;
}

function ConnectionAction({ wide }: { wide: boolean }) {
  return <button className="desktop-connection-action" title="桌面运行状态" aria-label="桌面运行状态" onClick={() => { void window.dshDesktop?.showConnection(); }}>
    <Icon kind="connect" />{wide && <span>DSH Desktop</span>}
  </button>;
}

function DesktopSettings() {
  const [info, setInfo] = useState<DesktopInfo>();
  useEffect(() => { void window.dshDesktop?.getInfo().then(setInfo); }, []);
  return <div><div className="desktop-settings-row"><div><strong>桌面应用</strong><p>{info ? `DSH Desktop ${info.version} · 独立本机运行` : 'DSH Desktop'}</p></div><button onClick={() => { void window.dshDesktop?.showConnection(); }}>运行状态</button></div><UpdateScheduleSettings /><ComputerSettings /></div>;
}

/** Settings/search have no public controller; target their version-pinned UI controls. */
export function dispatchCommand(command: DesktopCommand, ctx: DesktopContext) {
  switch (command) {
    case 'new-session': ctx.get('uiWorkspace').startSession(); break;
    case 'sidebar': ctx.layout.toggleSidebar(); break;
    case 'details': if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded(); break;
    case 'settings': document.querySelector<HTMLButtonElement>('button.VOzbGW_trigger')?.click(); break;
    case 'search': document.querySelector<HTMLButtonElement>('button.bhn1Oq_searchButton')?.click(); break;
  }
}

export function apply(ctx: DesktopContext) {
  installSidebarBrowser(ctx);
  installDocumentPreviews(ctx);
  installLocalOpen(ctx);
  ctx.effect(() => ctx.theme.overrideTokens(name, Object.fromEntries(Object.entries(palette).map(([key, [light, dark]]) => [key, { light, dark }]))), 'desktop: palette');
  ctx.effect(() => {
    const sync = (snapshot: ThemeSnapshot) => { void window.dshDesktop?.setColorScheme(snapshot.active.colorScheme); };
    sync(ctx.theme.getTheme());
    return ctx.on('theme/change', sync);
  }, 'desktop: native appearance');
  ctx.effect(() => window.dshDesktop?.onCommand(command => dispatchCommand(command, ctx)) ?? (() => {}), 'desktop: menu commands');
  const connection = ctx.get('connection');
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: name, inject: () => ({ state: connection.state, reconnect: () => connection.reconnect() }) }, TitleBar));
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', priority: -100 }, () => <span className="desktop-brand">DSH</span>));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: name, order: 100 }, ConnectionAction));
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({ name: 'settings.general.item', id: name, order: 100 }, DesktopSettings));
}
