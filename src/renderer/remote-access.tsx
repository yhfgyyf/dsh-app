import { useEffect, useState } from 'react';
import { defaultRemoteConfig, type RemoteState, type RemoteAction } from '../shared/remote-access.ts';

export function RemoteAccessSettings() {
  const [state, setState] = useState<RemoteState>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(defaultRemoteConfig());
  const [forget, setForget] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const api = window.dshDesktop; if (!api) return;
    void api.getRemoteState().then(s => { setState(s); setDraft(s.config); }).catch(() => setError('无法读取远程设置。'));
    const unsubscribe = api.onRemoteState(setState);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);
  async function act(action: RemoteAction | RemoteAction[]) {
    setBusy(true); setError('');
    try {
      for (const step of Array.isArray(action) ? action : [action]) {
        const next = await window.dshDesktop?.remoteAction(step);
        if (next) { setState(next); setDraft(next.config); }
      }
      setCode('');
    }
    catch (e) { setError(e instanceof Error ? e.message : '远程操作失败。'); }
    finally { setBusy(false); }
  }
  if (!state) return error ? <p role="alert">{error}</p> : null;
  const status = { disabled: '未连接', connecting: '连接中', online: '已连接', reconnecting: '正在重连', error: '连接异常' }[state.status];
  const devices = state.devices.filter(d => !d.revoked);
  return <div className="desktop-remote-settings">
    <div className="desktop-computer-controls">
      <span>手机远程控制</span>
      <div className="desktop-browser-use-actions">
        <button type="button" className="desktop-settings-button" aria-expanded={editing} onClick={() => { setDraft(state.config); setEditing(!editing); }}>管理连接</button>
        <button type="button" className="desktop-computer-switch" role="switch" aria-label="手机远程控制" aria-checked={state.config.enabled} disabled={busy} onClick={() => {
          if (!state.config.enabled) setEditing(true);
          void act({ type: 'configure', config: { ...state.config, enabled: !state.config.enabled } });
        }}><span /></button>
      </div>
    </div>
    {editing && <div className="desktop-remote-panel" aria-label="手机远程连接设置">
      <div className="desktop-remote-status" role="status">
        <strong>{state.registered ? `中继已注册 · ${status}` : '中继未注册'}</strong>
        <span>{state.config.enabled ? (state.lan?.available ? '局域网可连接' : '未检测到可用局域网') : '手机远程控制已关闭'}</span>
      </div>
      <form onSubmit={e => { e.preventDefault(); void act([{ type: 'configure', config: { ...draft, relay: draft.relay.trim() } }, { type: 'register', code: code.trim() }]); }}>
        <label>中继地址<input type="url" value={draft.relay} placeholder="https://relay.example.com" disabled={busy || state.registered} onChange={e => setDraft({ ...draft, relay: e.target.value })} /></label>
        {!state.registered && <><label>注册码<input type="password" autoComplete="off" value={code} maxLength={128} disabled={busy} onChange={e => setCode(e.target.value)} /></label>
          <button type="submit" disabled={busy || !code.trim() || !draft.relay.trim()}>注册电脑</button></>}
      </form>
      {state.registered && <div className="desktop-remote-actions">
        <button disabled={busy} onClick={() => setForget(!forget)}>解除注册</button>
        {forget && <><span>中继访问将停止，局域网绑定保留。</span><button disabled={busy} onClick={() => { setForget(false); void act({ type: 'unregister' }); }}>确认解除注册</button></>}
      </div>}
      <div className="desktop-remote-actions"><strong>手机绑定</strong><button disabled={busy} onClick={() => void act({ type: 'pair' })}>{state.pairing ? '刷新二维码' : '扫码绑定手机'}</button></div>
      <p className="desktop-remote-note">同一局域网可直接扫码；注册中继后，也可从其他网络连接。</p>
      {state.pairing && <div className="desktop-remote-pair">
        {state.pairing.expiresAt > now ? <><img src={state.pairing.qr} alt="Android 手机配对二维码" width={300} height={300} /><p>使用 DSH Remote 扫码，{Math.ceil((state.pairing.expiresAt - now) / 1000)} 秒内有效。</p><p className="desktop-remote-note">扫码将允许这部手机查看和操作电脑上的会话。</p></> : <p>二维码已过期，请重新生成。</p>}
        <button disabled={busy} onClick={() => void act({ type: 'cancel-pair' })}>取消配对</button>
      </div>}
      {!devices.length && <p className="desktop-remote-note">尚未绑定手机</p>}
      {devices.map(d => <div key={d.id} className="desktop-remote-device"><div><strong>{d.name}</strong><span>{d.online ? '已连接' : '已绑定 · 离线'}</span></div>
        <button disabled={busy} onClick={() => void act({ type: 'revoke', id: d.id })}>解绑</button>
      </div>)}
      {!state.secureStorage && <p className="desktop-remote-note">系统密钥环不可用，当前绑定仅在本次运行有效。</p>}
      <p className="desktop-remote-note">关闭窗口后继续在后台运行；从应用菜单退出后停止连接。</p>
    </div>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
  </div>;
}
