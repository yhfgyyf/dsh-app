import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopInfo } from '../../shared/desktop-api.ts';
import './style.css';
import '../updates.css';
import { UpdateIcon } from '../updates.tsx';

function App() {
  const [info, setInfo] = useState<DesktopInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void window.dshDesktop?.getInfo().then(value => { setInfo(value); setError(value.error ?? ''); }); }, []);
  async function restart() {
    setBusy(true); setError('');
    try { const result = await window.dshDesktop?.reconnect(); if (!result?.ok) setError(result?.error ?? '启动接口不可用。'); }
    catch { setError('启动尚未完成，请重试。'); }
    finally { setBusy(false); }
  }
  return <><div className="setup-titlebar">DSH Desktop</div><main>
    <div className="setup-mark" aria-hidden="true">dsh<span>_</span></div>
    <h1>{error ? 'DSH 需要重新启动' : '正在准备工作空间'}</h1>
    <p className="intro">会话、工具和工作流都在此 App 中运行。</p>
    {error && <div className="error" role="alert">{error}</div>}
    <button className="connect" onClick={() => { void restart(); }} disabled={busy || info?.connecting}>{busy || info?.connecting ? '正在启动…' : '打开工作空间'}<span aria-hidden="true">→</span></button>
    <footer><span>DSH Desktop {info?.version ?? ''}</span><UpdateIcon /><button onClick={() => { void window.dshDesktop?.openExternal('https://github.com/deepseek-ai/deepseek-harness'); }}>项目文档 ↗</button></footer>
  </main></>;
}
createRoot(document.getElementById('root')!).render(<App />);
