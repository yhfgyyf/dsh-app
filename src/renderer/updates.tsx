import { useEffect, useRef, useState } from 'react';
import type { UpdateSchedule, UpdateState } from '../shared/updates.ts';

function useUpdateState() {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    const api = window.dshDesktop;
    if (!api) return;
    const unsubscribe = api.onUpdateState(setState);
    void api.getUpdateState().then(setState);
    return unsubscribe;
  }, []);
  return state;
}

export function UpdateControls() {
  const state = useUpdateState();
  const [error, setError] = useState('');
  if (!state) return null;
  const busy = ['checking', 'downloading', 'installing'].includes(state.status);
  const label = state.status === 'checking' ? '正在检查 GitHub…'
    : state.status === 'current' ? '当前已是此系统可用的最新版本'
    : state.status === 'available' ? `发现新版本 ${state.version}`
    : state.status === 'downloading' ? state.progress === 100 ? '正在校验安装包…' : `正在下载 ${state.version} · ${state.progress ?? 0}%`
    : state.status === 'ready' ? `${state.version} 已下载并通过校验`
    : state.status === 'installing' ? '正在重启并安装更新…'
    : state.status === 'error' ? state.error : state.schedule.mode === 'startup' ? '每次打开 App 后自动检查一次 GitHub' : `App 运行时，每天 ${state.schedule.time} 自动检查一次`;
  async function action(kind: 'checkForUpdates' | 'downloadUpdate' | 'installUpdate') {
    setError('');
    try { await window.dshDesktop?.[kind](); }
    catch { setError('更新操作未完成，请重试。'); }
  }
  async function setSchedule(schedule: UpdateSchedule) {
    setError('');
    try { await window.dshDesktop?.setUpdateSchedule(schedule); }
    catch { setError('检查时间未能保存，请重试。'); }
  }
  return <section className="desktop-updates" aria-label="应用更新">
    <p>当前版本 {state.currentVersion}</p>
    <div className="desktop-update-schedule">
      <label>自动检查<select aria-label="更新检查模式" value={state.schedule.mode} onChange={event => { void setSchedule({ ...state.schedule, mode: event.target.value as UpdateSchedule['mode'] }); }}><option value="startup">每次打开 App</option><option value="daily">每日定时</option></select></label>
      {state.schedule.mode === 'daily' && <label>本地时间<input aria-label="每日检查时间" type="time" value={state.schedule.time} onChange={event => { if (event.target.value) void setSchedule({ ...state.schedule, time: event.target.value }); }} /></label>}
    </div>
    <p role="status">{label}</p>
    {error && <p role="alert">{error}</p>}
    {state.status === 'downloading' && <progress aria-label="更新下载进度" value={state.progress ?? 0} max={100} />}
    {state.status === 'ready' && <p className="desktop-update-hint">安装会重启应用，请先等待当前任务完成。会话和配置会保留。</p>}
    <div className="desktop-update-actions">
      <button disabled={busy || state.status === 'ready'} onClick={() => { void action('checkForUpdates'); }}>检查更新</button>
      {state.status === 'available' && <button onClick={() => { void action('downloadUpdate'); }}>下载更新</button>}
      {state.status === 'ready' && <button onClick={() => { void action('installUpdate'); }}>重启并安装</button>}
      {state.releaseUrl && <button onClick={() => { void window.dshDesktop?.openExternal(state.releaseUrl!); }}>版本说明 ↗</button>}
    </div>
  </section>;
}

/** The native menu can open this dialog even when no update is available. */
export function UpdateCenter({ always = false }: { always?: boolean }) {
  const state = useUpdateState();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => window.dshDesktop?.onCommand(command => { if (command === 'updates') setOpen(true); }), []);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const hasUpdate = state && ['available', 'downloading', 'ready'].includes(state.status);
  return <>
    {(always || hasUpdate) && <button className="desktop-update-badge" aria-label="应用更新" onClick={() => setOpen(true)}>{hasUpdate ? `更新 ${state.version}` : '应用更新'}</button>}
    <dialog ref={dialog} className="desktop-update-dialog" aria-label="应用更新" role="dialog" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <div className="desktop-update-heading"><strong>应用更新</strong><button aria-label="关闭更新窗口" onClick={() => setOpen(false)}>×</button></div>
      <UpdateControls />
    </dialog>
  </>;
}
