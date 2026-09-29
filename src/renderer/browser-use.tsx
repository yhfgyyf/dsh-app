import { useEffect, useRef, useState } from 'react';
import type { BrowserUseState } from '../shared/browser-use.ts';

export function BrowserUseSettings() {
  const [state, setState] = useState<BrowserUseState>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const credentialsRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const api = window.dshDesktop;
    if (!api) return;
    const unsubscribe = api.onBrowserUseState(setState);
    void api.getBrowserUseState().then(setState).catch(() => setError('无法读取浏览器操作状态。'));
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!editing) return;
    credentialsRef.current?.scrollIntoView({ block: 'nearest' });
    credentialsRef.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [editing]);
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
  async function save(value: string | null) {
    setPending(true);
    setError('');
    try {
      const next = await window.dshDesktop?.saveBrowserUseToken(value);
      if (next) setState(next);
      setToken(''); setEditing(false);
    } catch (error) { setError(error instanceof Error ? error.message : '自动连接设置保存失败。'); }
    finally { setPending(false); }
  }
  const busy = pending || state.phase === 'starting' || state.phase === 'stopping';
  return <div className="desktop-browser-use-settings">
    <div className="desktop-computer-controls">
      <span>浏览器操作（Browser Use）</span>
      <div className="desktop-browser-use-actions">
        <button type="button" className="desktop-browser-use-connect" aria-expanded={editing} disabled={busy} onClick={() => { setToken(''); setError(''); setEditing(!editing); }}>自动连接</button>
        <button type="button" className="desktop-computer-switch" role="switch" aria-label="浏览器操作" aria-checked={state.enabled} aria-busy={busy} disabled={busy} onClick={() => { void toggle(); }}><span /></button>
      </div>
    </div>
    {editing && <form ref={credentialsRef} className="desktop-browser-use-credentials" aria-label="浏览器自动连接" onSubmit={event => { event.preventDefault(); void save(token); }}>
      <p>保存扩展连接令牌后，DSH 可自动连接浏览器并使用已登录的会话，无需每次确认。</p>
      <label htmlFor="desktop-browser-use-token">扩展连接令牌{state.extensionTokenConfigured ? '（已保存，填写可替换）' : ''}</label>
      <input id="desktop-browser-use-token" type="password" autoComplete="off" spellCheck={false} value={token} maxLength={1100} placeholder="粘贴令牌或完整的环境变量行" onChange={event => setToken(event.target.value)} disabled={busy} />
      <p>令牌仅在本机加密保存。更改后重启 App 生效。</p>
      <div className="desktop-browser-use-credential-actions">
        <button type="submit" disabled={busy || !token.trim()}>保存</button>
        {(state.extensionTokenConfigured || state.credentialError) && <button type="button" disabled={busy} onClick={() => { void save(null); }}>清除令牌</button>}
        <button type="button" disabled={busy} onClick={() => { setToken(''); setEditing(false); }}>取消</button>
      </div>
    </form>}
    {state.restartRequired && <p className="desktop-browser-use-note" role="status">自动连接设置已保存，重启 App 后生效。</p>}
    {(error || state.error || state.credentialError) && <p className="desktop-browser-use-note" role="alert">{error || state.error || state.credentialError}</p>}
  </div>;
}
