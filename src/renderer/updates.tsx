import { useEffect, useState } from 'react';
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

export function UpdateScheduleSettings() {
  const state = useUpdateState();
  const [error, setError] = useState('');
  if (!state) return null;
  async function setSchedule(schedule: UpdateSchedule) {
    setError('');
    try { await window.dshDesktop?.setUpdateSchedule(schedule); }
    catch { setError('检查时间未能保存，请重试。'); }
  }
  return <div className="desktop-update-settings">
    <div className="desktop-update-schedule">
      <label>自动检查更新<select aria-label="更新检查模式" value={state.schedule.mode} onChange={event => { void setSchedule({ ...state.schedule, mode: event.target.value as UpdateSchedule['mode'] }); }}><option value="startup">每次打开 App</option><option value="daily">每日定时</option></select></label>
      {state.schedule.mode === 'daily' && <label>本地时间<input aria-label="每日检查时间" type="time" value={state.schedule.time} onChange={event => { if (event.target.value) void setSchedule({ ...state.schedule, time: event.target.value }); }} /></label>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}

/** Automatic discovery exposes one compact action in the title bar. */
export function UpdateIcon() {
  const state = useUpdateState();
  const [error, setError] = useState('');
  if (!state?.version || !['available', 'downloading', 'ready', 'installing', 'error'].includes(state.status)) return null;
  const downloading = state.status === 'downloading';
  const ready = state.status === 'ready';
  const busy = downloading || state.status === 'installing';
  const label = error || (state.status === 'error' ? `${state.error} 点击重试下载 ${state.version}`
    : downloading ? state.progress === 100 ? '正在校验更新…' : `正在下载 ${state.version} · ${state.progress ?? 0}%`
    : ready ? `${state.version} 已下载，点击重启安装（请先等待当前任务完成）`
    : state.status === 'installing' ? '正在重启安装更新…' : `下载更新 ${state.version}`);
  async function activate() {
    setError('');
    try { await window.dshDesktop?.[ready ? 'installUpdate' : 'downloadUpdate'](); }
    catch { setError('更新操作未完成，点击重试。'); }
  }
  return <button className="desktop-update-icon" data-update-state={state.status} title={label} aria-label={label} aria-busy={busy} disabled={busy} onClick={() => { void activate(); }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {downloading ? <><circle cx="12" cy="12" r="9" opacity=".2" /><circle cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${state.progress ?? 0} 100`} transform="rotate(-90 12 12)" /></>
        : ready || state.status === 'installing' ? <><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7" /></>
        : <><circle cx="12" cy="12" r="9" /><path d="M12 7v10m-4-4 4 4 4-4" /></>}
    </svg>
  </button>;
}
