import { useEffect, useState } from 'react';
import type { BrowserUseState } from '../shared/browser-use.ts';

export function BrowserUseSettings() {
  const [state, setState] = useState<BrowserUseState>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const api = window.dshDesktop;
    if (!api) return;
    const unsubscribe = api.onBrowserUseState(setState);
    void api.getBrowserUseState().then(setState).catch(() => setError('无法读取浏览器操作状态。'));
    return unsubscribe;
  }, []);
  if (!state) return error ? <p role="alert">{error}</p> : null;
  async function toggle() {
    setPending(true);
    try {
      setError('');
      const next = await window.dshDesktop?.setBrowserUseEnabled(!state?.enabled);
      if (next) setState(next);
    } catch { setError('未能更改浏览器操作开关，请重试。'); }
    finally { setPending(false); }
  }
  const busy = pending || state.phase === 'starting' || state.phase === 'stopping';
  return <div className="desktop-browser-use-settings">
    <div className="desktop-computer-controls">
      <span>浏览器操作（Browser Use）</span>
      <button type="button" className="desktop-computer-switch" role="switch" aria-label="浏览器操作" aria-checked={state.enabled} aria-busy={busy} disabled={busy} onClick={() => { void toggle(); }}><span /></button>
    </div>
    {(error || state.error) && <p className="desktop-browser-use-note" role="alert">{error || state.error}</p>}
  </div>;
}
