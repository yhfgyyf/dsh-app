import { useEffect, useState } from 'react';
import type { ComputerState } from '../shared/computer-use.ts';

function useComputerState() {
  const [state, setState] = useState<ComputerState>();
  useEffect(() => {
    const api = window.dshDesktop;
    if (!api) return;
    const unsubscribe = api.onComputerState(setState);
    void api.getComputerState().then(setState);
    return unsubscribe;
  }, []);
  return state;
}

function ComputerControls({ state }: { state: ComputerState }) {
  const [error, setError] = useState('');
  async function request() {
    try { setError(''); await window.dshDesktop?.requestComputerPermissions(); }
    catch { setError('未能读取系统权限，请重试。'); }
  }
  return <div className="desktop-computer-controls">
    <strong>电脑操作</strong>
    <p>{state.owner ? state.owner.reason : '在对话中说明要操作的应用和任务，确认授权后开始。'}</p>
    {state.owner && <p>范围：{state.owner.applicationPid ? `应用 PID ${state.owner.applicationPid}` : '本机桌面'} · {state.action ? '正在操作' : state.phase === 'stopping' ? '正在停止' : '等待下一步'}</p>}
    <p>辅助功能：{state.permissions.accessibility ? '可用' : '未授权'} · 屏幕录制：{state.permissions.screenRecording ? '可用' : '未授权'}</p>
    <p>可随时点击停止。{state.stopShortcutAvailable ? `快捷键：${navigator.platform.includes('Mac') ? '⌘ + Option' : 'Ctrl + Alt'} + Shift + Esc。` : '全局快捷键当前不可用，请使用 App 停止按钮。'}</p>
    <button onClick={() => { void request(); }}>检查并申请系统权限</button>
    {(state.error || error) && <p role="alert">{error || state.error}</p>}
  </div>;
}

export function ComputerSettings() {
  const state = useComputerState();
  return state ? <ComputerControls state={state} /> : null;
}

export function ComputerControl() {
  const state = useComputerState();
  const [error, setError] = useState('');
  if (!state) return null;
  async function stop() {
    try { setError(''); await window.dshDesktop?.stopComputerUse(); }
    catch { setError('停止失败，请重试或退出 App。'); }
  }
  return <div className="desktop-computer" data-computer-phase={state.phase}>
    <details>
      <summary className="desktop-icon" title="电脑操作" aria-label="电脑操作">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M8 21h8m-4-4v4" /></svg>
      </summary>
      <div className="desktop-computer-popover" role="dialog" aria-label="电脑操作状态"><ComputerControls state={state} /></div>
    </details>
    {(state.owner || state.phase === 'stopping') && <button className="desktop-computer-stop" aria-label="立即停止电脑操作" disabled={state.phase === 'stopping'} onClick={() => { void stop(); }}>{state.phase === 'stopping' ? '停止中…' : '停止电脑操作'}</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
