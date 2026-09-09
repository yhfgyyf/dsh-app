import { useEffect, useRef, useState } from 'react';
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { currentLocalTarget } from '../shared/local-open.ts';
import type { LocalOpenAction, LocalOpenTarget } from '../shared/local-open.ts';
import type { BrowserContext } from './sidebar-browser.tsx';

type Props = {
  ctx: BrowserContext;
  sessionId: string;
  useSessions<T>(selector: (state: { byId: Record<string, { cwd?: string } | undefined> }) => T): T;
};

function LocalOpen({ ctx, sessionId, useSessions }: Props) {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<LocalOpenTarget>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  useEffect(() => { setOpen(false); setError(undefined); }, [sessionId]);
  const current = () => currentLocalTarget(ctx.sidebarRight.isExpanded() ? ctx.sidebarRight.active()?.contentId : undefined, sessionId, cwd);
  const launch = async (action: LocalOpenAction, chosen?: LocalOpenTarget) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpen(false); setBusy(true); setError(undefined);
    try { await window.dshDesktop?.openLocal({ action, target: chosen, cwd }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法打开此文件。'); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <div className="desktop-local-open">
    <Menu open={open} portal align="end" dense onClose={() => setOpen(false)}
      items={[
        { type: 'label', id: 'target', text: target && 'address' in target ? decodeURIComponent(target.address.slice(target.address.lastIndexOf('/') + 1)) : '先在右侧打开文件，或选择文件' },
        { id: 'default', label: '用默认应用打开', disabled: !target },
        { id: 'choose-app', label: '选择其他应用…', disabled: !target },
        { id: 'reveal', label: '在文件夹中显示', disabled: !target },
        { type: 'separator', id: 'picker' },
        { id: 'pick-file', label: '选择文件…' },
        { id: 'pick-directory', label: '选择文件夹…' },
        { id: 'workspace', label: '打开工作区文件夹', disabled: !cwd },
      ]}
      onSelect={action => { void launch(action === 'workspace' ? 'default' : action as LocalOpenAction, action === 'workspace' && cwd ? { path: cwd } : target); }}
      anchor={<div className="desktop-local-open-buttons">
        <button aria-label="在本地打开" title="使用系统应用打开右侧当前文件；没有当前文件时选择文件" disabled={busy} onClick={() => {
          const chosen = current();
          void launch(chosen ? 'default' : 'pick-file', chosen);
        }}>↗ <span>在本地打开</span></button>
        <button aria-label="选择本地打开方式" title="选择本地打开方式" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => { setTarget(current()); setOpen(value => !value); }}>⌄</button>
      </div>}
    />
    {error && <span className="desktop-local-open-error" role="alert" title={error}>{error}</span>}
  </div>;
}

export function installLocalOpen(ctx: BrowserContext): void {
  // Shadow only the workspace-only header cell using the public slot priority.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'open-in-app', order: -10, priority: -100, inject: () => ({ ctx }),
  }, LocalOpen));
}
