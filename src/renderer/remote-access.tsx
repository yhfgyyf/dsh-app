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
  async function act(action: RemoteAction) {
    setBusy(true); setError('');
    try { const next = await window.dshDesktop?.remoteAction(action); if (next) { setState(next); setDraft(next.config); } setCode(''); }
    catch (e) { setError(e instanceof Error ? e.message : '远程操作失败。'); }
    finally { setBusy(false); }
  }
  if (!state) return error ? <p role="alert">{error}</p> : null;
  const status = { disabled: '已关闭', connecting: '连接中', online: '已连接', reconnecting: '正在重连', error: '连接异常' }[state.status];
  return <div className="desktop-remote-settings">
    <div className="desktop-computer-controls">
      <span>手机远程控制</span>
      <div className="desktop-browser-use-actions">
        <button type="button" aria-expanded={editing} onClick={() => { setDraft(state.config); setEditing(!editing); }}>管理连接</button>
        <button type="button" className="desktop-computer-switch" role="switch" aria-label="手机远程控制" aria-checked={state.config.enabled} disabled={busy} onClick={() => {
          if (!state.registered) { setEditing(true); return; }
          void act({ type: 'configure', config: { ...state.config, enabled: !state.config.enabled } });
        }}><span /></button>
      </div>
    </div>
    {editing && <div className="desktop-remote-panel" aria-label="手机远程连接设置">
      <p role="status">{status} · {state.registered ? '电脑已注册' : '电脑尚未注册'}</p>
      <button disabled={busy} onClick={() => { void window.dshDesktop?.exportRemoteDiagnostics().catch(() => setError('诊断导出失败，请重试。')); }}>导出诊断</button>
      <form onSubmit={e => { e.preventDefault(); void act({ type: 'configure', config: draft }); }}>
        <label>中继地址<input type="url" value={draft.relay} placeholder="https://relay.example.com" disabled={busy || state.registered} onChange={e => setDraft({ ...draft, relay: e.target.value })} /></label>
        <label>电脑名称<input value={draft.name} maxLength={80} disabled={busy} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label><input type="checkbox" checked={draft.background} onChange={e => setDraft({ ...draft, background: e.target.checked })} />关闭窗口后继续运行</label>
        <label><input type="checkbox" checked={draft.sessionOnly} onChange={e => setDraft({ ...draft, sessionOnly: e.target.checked })} />仅本次运行，重启后重新注册配对</label>
        {!state.secureStorage && <p>系统密钥环不可用，请选择“仅本次运行”。</p>}
        <button disabled={busy} type="submit">保存设置</button>
      </form>
      {!state.registered && <form onSubmit={e => { e.preventDefault(); void act({ type: 'register', code }); }}>
        <label>一次性设备注册码<input type="password" autoComplete="off" value={code} maxLength={128} onChange={e => setCode(e.target.value)} /></label>
        <button type="submit" disabled={busy || !code || !state.config.relay}>注册电脑</button>
      </form>}
      {state.registered && <div className="desktop-remote-actions">
        <button disabled={busy || !state.config.enabled} onClick={() => void act({ type: 'pair' })}>配对手机</button>
        <button disabled={busy || !state.config.enabled} onClick={() => void act({ type: 'reconnect' })}>重新连接</button>
      </div>}
      {state.pairing && <div className="desktop-remote-pair">
        {state.pairing.expiresAt > now ? <><img src={state.pairing.qr} alt="Android 手机配对二维码" width={300} height={300} /><p>请使用 DSH Remote Android 扫码，剩余 {Math.ceil((state.pairing.expiresAt - now) / 1000)} 秒。</p></> : <p>二维码已过期，请重新生成。</p>}
        <button disabled={busy} onClick={() => void act({ type: 'cancel-pair' })}>取消配对</button>
      </div>}
      {state.pending.map(p => <div key={p.id} className="desktop-remote-device"><strong>{p.name}</strong><span>{p.account}</span>
        <button disabled={busy} onClick={() => void act({ type: 'approve', id: p.id, role: 'viewer' })}>允许仅查看</button>
        <button disabled={busy} onClick={() => void act({ type: 'approve', id: p.id, role: 'control' })}>允许会话控制</button>
      </div>)}
      {state.devices.filter(d => !d.revoked).map(d => <div key={d.id} className="desktop-remote-device"><strong>{d.name}</strong><span>{d.role === 'viewer' ? '仅查看' : '会话控制'}</span><span>{d.online ? '在线' : '离线'}{d.lastSeen ? ` · 最近连接 ${new Date(d.lastSeen).toLocaleString()}` : ''}</span>
        <button disabled={busy} onClick={() => void act({ type: 'revoke', id: d.id })}>撤销</button>
      </div>)}
      {state.registered && <div className="desktop-remote-actions">
        <button disabled={busy} onClick={() => setForget(!forget)}>注销电脑</button>
        {forget && <><span>将断开并清除所有手机配对。</span><button disabled={busy} onClick={() => { setForget(false); void act({ type: 'unregister' }); }}>确认注销</button></>}
      </div>}
      <p>会话控制允许通过 DSH 执行电脑上的任务。电脑退出或关机后无法远程访问。</p>
    </div>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
  </div>;
}
