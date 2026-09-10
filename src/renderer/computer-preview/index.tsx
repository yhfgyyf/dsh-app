import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComputerPreview, ComputerState } from '../../shared/computer-use.ts';
import './style.css';

declare global {
  interface Window {
    computerPreview: {
      state(): Promise<ComputerState>; frame(): Promise<ComputerPreview | undefined>;
      stop(): Promise<void>; hide(): Promise<void>; returnToApp(): Promise<void>;
      onState(listener: (state: ComputerState) => void): () => void;
    };
  }
}

function Preview() {
  const [state, setState] = useState<ComputerState>();
  const [frame, setFrame] = useState<ComputerPreview>();
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const latest = useRef(state);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const update = (value: ComputerState) => {
      if (disposed) return;
      const before = latest.current;
      if (value.phase !== 'active' || value.owner?.sessionId !== before?.owner?.sessionId || value.target?.pid !== before?.target?.pid || value.target?.windowId !== before?.target?.windowId) setFrame(undefined);
      latest.current = value; setState(value);
    };
    const unsubscribe = window.computerPreview.onState(update);
    void window.computerPreview.state().then(update).catch(() => setError('无法读取电脑操作状态。'));
    async function poll() {
      try {
        if (!document.hidden) {
          const owner = latest.current?.owner?.sessionId;
          const value = await window.computerPreview.frame();
          const current = latest.current;
          if (!disposed && value && current?.enabled && current.phase === 'active' && current.owner?.sessionId === owner && current.target?.pid === value.target.pid && current.target?.windowId === value.target.windowId) setFrame(value);
        }
      } catch { if (!disposed) { setFrame(undefined); setError('暂时无法读取画面。'); } }
      if (!disposed) { setNow(Date.now()); timer = setTimeout(() => { void poll(); }, 1000); }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
  }, []);
  async function action(name: 'stop' | 'hide' | 'returnToApp') {
    try { setError(''); await window.computerPreview[name](); }
    catch { setError(name === 'stop' ? '停止失败，请重试或退出 DSH。' : '操作失败，请重试。'); }
  }
  const actions: Record<string, string> = { observe: '正在观察', click: '点击', double_click: '双击', right_click: '右键点击', type_text: '输入文字', press_key: '按键', hotkey: '快捷键', scroll: '滚动', drag: '拖动', set_value: '设置控件', invoke_menu: '选择菜单', bring_to_front: '切换窗口', launch_app: '打开应用' };
  const title = state?.target?.windowTitle || state?.target?.appName || '等待选择窗口';
  const fresh = frame?.image && now - frame.capturedAt < 6000;
  return <main>
    <header><span className="dot" /><strong>电脑操作</strong><span className="status">{state?.action ? actions[state.action] || '正在操作' : fresh ? '实时画面' : '等待更新'}</span><button aria-label="隐藏画中画" title="可从 DSH 电脑操作菜单重新打开" onClick={() => { void action('hide'); }}>−</button></header>
    <div className="target" title={title}>{title}</div>
    <div className="screen">{fresh ? <img alt="正在操作的应用窗口" src={`data:${frame.image!.mimeType};base64,${frame.image!.dataBase64}`} /> : <p>{frame?.error || '等待目标窗口画面…'}</p>}</div>
    <div className="purpose" title={state?.owner?.reason}>{state?.owner?.reason}</div>
    {error && <p className="error" role="alert">{error}</p>}
    <footer><button onClick={() => { void action('returnToApp'); }}>返回 DSH</button><button className="stop" disabled={state?.phase === 'stopping'} onClick={() => { void action('stop'); }}>立即停止</button></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
