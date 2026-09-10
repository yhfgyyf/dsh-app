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
  const [pending, setPending] = useState(false);
  async function toggle() {
    setPending(true);
    try { setError(''); await window.dshDesktop?.setComputerEnabled(!state.enabled); }
    catch { setError('未能更改电脑操作开关，请重试。'); }
    finally { setPending(false); }
  }
  return <div className="desktop-computer-controls">
    <span>电脑操作</span>
    <button type="button" className="desktop-computer-switch" role="switch" aria-label="电脑操作" aria-checked={state.enabled} aria-busy={pending} disabled={pending} title={error || state.error || undefined} onClick={() => { void toggle(); }}><span /></button>
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
      <div className="desktop-computer-popover" role="dialog" aria-label="电脑操作状态"><ComputerControls state={state} />{state.phase === 'active' && <button onClick={() => { void window.dshDesktop?.showComputerPreview().catch(() => setError('无法打开画中画。')); }}>显示画中画</button>}</div>
    </details>
    {(state.owner || state.phase === 'stopping') && <button className="desktop-computer-stop" aria-label="立即停止电脑操作" disabled={state.phase === 'stopping'} onClick={() => { void stop(); }}>{state.phase === 'stopping' ? '停止中…' : '停止电脑操作'}</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
