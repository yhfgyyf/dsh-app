import { useState, useSyncExternalStore } from 'react';
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import { Button, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BrowserContext } from './sidebar-browser.tsx';

type Target = { sessionId: string; displayTitle: string };
interface Context {
  slots: BrowserContext['slots'];
  get(name: 'sessions'): { delete(sessionId: string): Promise<void> };
}
function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, request }: Target & {
  useMenuOpenState(): [boolean, (open: boolean) => void]; request(target: Target): void;
}) {
  const [, setMenuOpen] = useMenuOpenState();
  return <MenuItemButton onSelect={() => { setMenuOpen(false); request({ sessionId, displayTitle }); }}>删除会话</MenuItemButton>;
}
function DeleteForm({ target, close, remove }: { target: Target; close(): void; remove(id: string): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancel = () => { if (!busy) close(); };
  const confirm = async () => {
    setBusy(true); setError('');
    try { await remove(target.sessionId); close(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); }
  };
  return <Modal open title="删除会话" closeLabel="关闭" onClose={cancel} footer={<>
    <Button variant="outline" disabled={busy} onClick={cancel}>取消</Button>
    <Button variant="primary" disabled={busy} onClick={() => { void confirm(); }}>{busy ? '正在删除…' : '确认删除'}</Button>
  </>}><p>永久删除“{target.displayTitle || '未命名会话'}”及其记录？此操作无法撤销。</p>{error && <p role="alert">{error}</p>}</Modal>;
}
function DeleteDialog({ pending, remove }: { pending: SnapshotStore<Target | null>; remove(id: string): Promise<void> }) {
  const target = useSyncExternalStore(pending.subscribe, pending.getSnapshot);
  return target ? <DeleteForm key={target.sessionId} target={target} close={() => pending.set(null)} remove={remove} /> : null;
}
/** Keep the local delete action on the upstream's public session-menu slots. */
export function installSessionDelete(ctx: Context) {
  const pending = createSnapshotStore<Target | null>(null);
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'desktop-delete-session', order: 500, inject: () => ({ request: (target: Target) => pending.set(target) }) }, DeleteMenuItem));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'desktop-delete-session', inject: () => ({ pending, remove: (id: string) => ctx.get('sessions').delete(id) }) }, DeleteDialog));
}
