import { useEffect, useState } from 'react';
import type { RemoteAction, RemoteState } from '../shared/remote-access.ts';

type Rpc = <T = any>(method: string, args?: object, signal?: AbortSignal) => Promise<T>;
type Profile = { id: string; name: string; relay: string; registered: boolean; pairedDevices: number; error?: string };
type State = { activeId: string; profiles: Profile[]; needsImport: boolean; nativeEnabled: boolean; remote: RemoteState | null; credentialStorage: string };
export const draftWriters = new Set<() => Promise<void>>();
export async function flushCollabDrafts() { await Promise.all([...draftWriters].map(save => save())); }

/** Only public configuration crosses the renderer. The runtime captures credentials through existing desktop IPC. */
export async function initializeRelayProfiles(rpc: Rpc) {
  const state = await rpc<State>('relays/state');
  if (!state.needsImport && !state.nativeEnabled) return state;
  const desktop = window.dshDesktop;
  if (!desktop) throw new Error('请在 DSH 电脑端保存或迁移中继配置。');
  const original = await desktop.getRemoteState();
  await desktop.remoteAction({ type: 'configure', config: { ...original.config, enabled: false } });
  return state.needsImport ? rpc<State>('relays/adopt', { config: original.config }) : rpc<State>('relays/state');
}

export function CollabRelaySettings({ rpc, changed }: { rpc: Rpc; changed(): Promise<void> }) {
  const [state, setState] = useState<State>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(''), [name, setName] = useState(''), [relay, setRelay] = useState(''), [code, setCode] = useState('');
  const [adding, setAdding] = useState(false), [newName, setNewName] = useState(''), [newRelay, setNewRelay] = useState('');
  const [confirmation, setConfirmation] = useState<'unregister' | 'archive' | ''>('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const load = () => { void rpc<State>('relays/state').then(value => { if (active) setState(value); }).catch(e => { if (active) setError(e.message); }); };
    load(); const timer = setInterval(() => { setNow(Date.now()); load(); }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [rpc]);
  useEffect(() => {
    if (!state || selected && state.profiles.some(p => p.id === selected)) return;
    const profile = state.profiles.find(p => p.id === state.activeId);
    setSelected(profile?.id ?? ''); setName(profile?.name ?? '');
  }, [state, selected]);
  useEffect(() => { setRelay(state?.remote?.config.relay ?? ''); setCode(''); setConfirmation(''); }, [state?.activeId]);
  async function action(run: () => Promise<State>, switching = false) {
    const pages = switching ? [...document.querySelectorAll<HTMLElement>('[data-testid="collab-page"]')].map(element => ({ element, inert: element.inert })) : [];
    for (const { element } of pages) element.inert = true;
    setBusy(true); setError('');
    try { setState(await run()); setCode(''); setConfirmation(''); await changed(); }
    catch (e) { setError(e instanceof Error ? e.message : '中继操作失败。'); }
    finally { for (const { element, inert } of pages) element.inert = inert; setBusy(false); }
  }
  const remote = (command: RemoteAction, confirm = false) => rpc<State>('relays/remote', { profileId: state?.activeId, action: command, confirm });
  const profile = state?.profiles.find(p => p.id === selected), current = state?.profiles.find(p => p.id === state.activeId), connected = state?.remote;
  const status = connected && { disabled: '未连接', connecting: '连接中', online: '已连接', reconnecting: '正在重连', error: '连接异常' }[connected.status];
  return <div className="collab collab-relay-settings" aria-label="中继配置管理">
    <h3>中继配置</h3>
    <p className="collab-muted">每套配置独立保存注册、协作身份、草稿、探索进度和手机绑定。切换会暂停当前探索并断开手机连接；切回后可手动恢复。</p>
    {!state ? <p>正在读取配置…</p> : state.needsImport || state.nativeEnabled ? <button disabled={busy} onClick={() => void action(() => initializeRelayProfiles(rpc))}>保存原配置并启用多中继管理</button> : <>
      <label>已保存的中继<select aria-label="已保存的中继" value={selected} disabled={busy} onChange={event => { const id = event.target.value; setSelected(id); setName(state.profiles.find(p => p.id === id)?.name ?? ''); setConfirmation(''); }}>
        {state.profiles.map(p => <option key={p.id} value={p.id}>{p.name}{p.id === state.activeId ? ' · 当前' : ''}{p.registered ? ' · 已注册' : ' · 未注册'}</option>)}
      </select></label>
      {profile && <><p className="collab-muted">{profile.relay || '尚未填写地址'} · {profile.pairedDevices} 部已绑定手机</p>
        {profile.error && <p role="alert">{profile.error}</p>}
        <div className="collab-actions"><button disabled={busy || selected === state.activeId} onClick={() => void action(async () => { await flushCollabDrafts(); return rpc<State>('relays/switch', { id: selected }); }, true)}>切换到此中继</button><button disabled={busy} onClick={() => setAdding(!adding)}>新增中继</button></div>
        <label>中继名称<input aria-label="中继名称" value={name} maxLength={80} disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <div className="collab-actions"><button disabled={busy || !name.trim() || name.trim() === profile.name} onClick={() => void action(() => rpc<State>('relays/rename', { id: selected, name }))}>保存名称</button>
          {selected !== state.activeId && <button disabled={busy} onClick={() => setConfirmation('archive')}>移出配置列表</button>}</div>
        {confirmation === 'archive' && <p className="collab-banner">只从本机列表移除；服务器注册仍有效，数据保留在本机。<button disabled={busy} onClick={() => void action(() => rpc<State>('relays/archive', { id: selected }))}>确认移出</button><button onClick={() => setConfirmation('')}>取消</button></p>}
      </>}
      {adding && <form onSubmit={e => { e.preventDefault(); void action(async () => { const result = await rpc<State>('relays/create', { name: newName, relay: newRelay.trim() }); setAdding(false); setNewName(''); setNewRelay(''); const added = result.profiles.at(-1)!; setSelected(added.id); setName(added.name); return result; }); }}>
        <label>新中继名称<input aria-label="新中继名称" required maxLength={80} value={newName} onChange={e => setNewName(e.target.value)} disabled={busy} /></label>
        <label>新中继地址<input aria-label="新中继地址" type="url" required value={newRelay} onChange={e => setNewRelay(e.target.value)} placeholder="https://relay.example.com" disabled={busy} /></label>
        <div className="collab-actions"><button type="submit" disabled={busy || !newName.trim() || !newRelay.trim()}>保存新中继</button><button type="button" onClick={() => setAdding(false)} disabled={busy}>取消</button></div>
      </form>}
      {connected && <section aria-label="当前中继注册与手机绑定"><h3>当前：{current?.name}</h3>
        <p role="status">{connected.registered ? '已注册' : '未注册'} · 手机连接{status}</p>
        {!connected.registered && <form onSubmit={e => { e.preventDefault(); void action(async () => { if (relay.trim() !== connected.config.relay) await remote({ type: 'configure', config: { ...connected.config, relay: relay.trim() } }); return remote({ type: 'register', code: code.trim() }); }); }}>
          <label>中继地址<input type="url" aria-label="中继地址" value={relay} onChange={e => setRelay(e.target.value)} disabled={busy || !!current?.relay} /></label>
          <label>注册码<input aria-label="注册码" type="password" autoComplete="off" value={code} maxLength={256} onChange={e => setCode(e.target.value)} disabled={busy} /></label>
          <button type="submit" disabled={busy || !relay.trim() || !code.trim()}>注册此中继</button>
        </form>}
        <div className="collab-actions"><button disabled={busy} onClick={() => void action(() => remote({ type: 'configure', config: { ...connected.config, enabled: !connected.config.enabled } }))}>{connected.config.enabled ? '断开手机连接' : '连接手机'}</button>
          <button disabled={busy} onClick={() => void action(() => remote({ type: 'pair' }))}>扫码绑定手机</button>
          {connected.registered && <button disabled={busy} onClick={() => setConfirmation('unregister')}>解除此中继注册</button>}</div>
        {confirmation === 'unregister' && <p className="collab-banner">这会撤销当前中继服务器上的设备注册，使对应手机的中继连接失效。本机协作记录保留。普通切换请使用上方切换按钮。<button disabled={busy} onClick={() => void action(() => remote({ type: 'unregister' }, true))}>确认解除注册</button><button onClick={() => setConfirmation('')}>取消</button></p>}
        {connected.pairing && <div><p>请使用 DSH Remote 扫码绑定到当前中继。</p>{connected.pairing.expiresAt > now ? <img src={connected.pairing.qr} width={280} height={280} alt="当前中继的手机配对二维码" /> : <p>二维码已过期，请重新生成。</p>}<button disabled={busy} onClick={() => void action(() => remote({ type: 'cancel-pair' }))}>取消配对</button></div>}
        {connected.pending.map(phone => <div key={phone.id}><span>{phone.name} 请求绑定</span><button disabled={busy} onClick={() => void action(() => remote({ type: 'approve', id: phone.id, role: 'control' }))}>允许控制</button><button disabled={busy} onClick={() => void action(() => remote({ type: 'approve', id: phone.id, role: 'viewer' }))}>仅查看</button></div>)}
        {connected.devices.filter(d => !d.revoked).map(phone => <div className="collab-row" key={phone.id}><span>{phone.name} · {phone.online ? '在线' : '已绑定 · 离线'}</span><button disabled={busy} onClick={() => void action(() => remote({ type: 'revoke', id: phone.id }))}>解绑</button></div>)}
        {!connected.devices.some(d => !d.revoked) && <p className="collab-muted">当前中继尚未绑定手机。</p>}
        {connected.error && <p role="alert" className="collab-error">{connected.error}</p>}
      </section>}
    </>}
    {error && <p className="collab-error" role="alert">{error}</p>}
  </div>;
}
