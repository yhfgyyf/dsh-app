import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';

type Rpc = <T = any>(method: string, args?: object, signal?: AbortSignal) => Promise<T>;
const markdownLabels = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '参考资料' };
export function CollabMarkdown({ children }: { children: string }) {
  return <div className="collab-prose"><MarkdownText text={children} labels={markdownLabels} /></div>;
}
type Capture = { id: string; abort: AbortController; stream?: MediaStream; recorder?: MediaRecorder; timer?: ReturnType<typeof setTimeout>; done?: Promise<Blob>; context?: AudioContext; providerId?: string; language?: string; seconds: number; bytes: number; onText(text: string): void };
type Voice = { id?: string; phase: string; error: string; start(id: string, onText: (text: string) => void): void; finish(): void; cancel(id?: string): void };
const VoiceContext = createContext<Voice | null>(null);

// The same speech/catalog and PCM16 speech/transcribe contract as the conversation composer.
export function CollabVoiceProvider({ rpc, children }: { rpc: Rpc; children: ReactNode }) {
  const current = useRef<Capture>(), [status, setStatus] = useState({ id: '', phase: '', error: '' });
  const release = (capture: Capture) => {
    clearTimeout(capture.timer);
    if (capture.recorder?.state === 'recording') capture.recorder.stop();
    capture.stream?.getTracks().forEach(track => track.stop());
    void capture.context?.close().catch(() => {});
  };
  const cancel = (id?: string) => {
    const capture = current.current;
    if (capture && (!id || id === capture.id)) { capture.abort.abort(); release(capture); current.current = undefined; setStatus({ id: '', phase: '', error: '' }); }
  };
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') cancel(); };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); cancel(); };
  }, []);
  const finish = async () => {
    const capture = current.current;
    if (!capture?.recorder || capture.recorder.state !== 'recording') return;
    clearTimeout(capture.timer); setStatus({ id: capture.id, phase: '识别中…', error: '' });
    capture.recorder.stop();
    try {
      const blob = await capture.done!;
      capture.stream?.getTracks().forEach(track => track.stop());
      capture.abort.signal.throwIfAborted();
      capture.context = new AudioContext();
      const audio = await capture.context.decodeAudioData(await blob.arrayBuffer());
      const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(Math.min(audio.duration, capture.seconds) * 16000)), 16000);
      const source = offline.createBufferSource(); source.buffer = audio; source.connect(offline.destination); source.start();
      const samples = (await offline.startRendering()).getChannelData(0);
      capture.abort.signal.throwIfAborted();
      const wave = new Uint8Array(44 + samples.length * 2), view = new DataView(wave.buffer);
      for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) for (let n = 0; n < text.length; n++) wave[offset + n] = text.charCodeAt(n);
      view.setUint32(4, wave.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples.length * 2, true);
      samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true));
      if (wave.length > capture.bytes) throw new Error('录音超过语音服务大小限制，请缩短录音。');
      let binary = ''; for (let offset = 0; offset < wave.length; offset += 8192) binary += String.fromCharCode(...wave.subarray(offset, offset + 8192));
      const result = await rpc<{ text: string }>('speech/transcribe', { request: { audioBase64: btoa(binary), providerId: capture.providerId, language: capture.language } }, capture.abort.signal);
      capture.abort.signal.throwIfAborted();
      if (!result.text.trim()) throw new Error('未识别到语音，请重试。');
      capture.onText(result.text.trim()); setStatus({ id: '', phase: '', error: '' });
    } catch (error) { if (!capture.abort.signal.aborted) setStatus({ id: capture.id, phase: '', error: error instanceof Error ? error.message : '语音识别失败' }); }
    finally { release(capture); if (current.current === capture) current.current = undefined; }
  };
  const start = async (id: string, onText: (text: string) => void) => {
    if (current.current) return;
    const capture: Capture = { id, onText, abort: new AbortController(), seconds: 60, bytes: 0 }; current.current = capture;
    setStatus({ id, phase: '准备语音…', error: '' });
    try {
      const catalog = await rpc('speech/catalog', {}, capture.abort.signal);
      const provider = catalog.providers.find((p: any) => p.id === catalog.selection.providerId);
      if (!provider || !['ready', 'standby'].includes(provider.preparation.phase)) throw new Error('请先在桌面设置中启用语音输入并准备语音模型。');
      capture.providerId = provider.id; capture.language = catalog.selection.language; capture.bytes = catalog.maxAudioBytes;
      capture.seconds = Math.min(catalog.maxDurationSeconds, Math.floor((capture.bytes - 44) / 32000));
      if (!Number.isFinite(capture.seconds) || capture.seconds <= 0) throw new Error('语音服务的录音限制无效。');
      capture.abort.signal.throwIfAborted();
      capture.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      capture.abort.signal.throwIfAborted();
      const recorder = capture.recorder = new MediaRecorder(capture.stream), chunks: Blob[] = [];
      capture.done = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
        recorder.onerror = () => { reject(new Error('录音被中断，请重试。')); cancel(id); };
      });
      void capture.done.catch(() => {});
      recorder.start(); setStatus({ id, phase: '正在录音', error: '' });
      capture.timer = setTimeout(() => { void finish(); }, capture.seconds * 1000);
    } catch (error) {
      release(capture); if (current.current === capture) current.current = undefined;
      if (!capture.abort.signal.aborted) setStatus({ id, phase: '', error: error instanceof DOMException && error.name === 'NotAllowedError' ? '请允许 DSH 使用麦克风后重试。' : error instanceof Error ? error.message : '无法开始语音输入' });
    }
  };
  return <VoiceContext.Provider value={{ ...status, start: (id, callback) => { void start(id, callback); }, finish: () => { void finish(); }, cancel }}>{children}</VoiceContext.Provider>;
}

export function CollabInput({ label, value, onChange, rows, maxLength, placeholder, disabled = false, markdown = false }: { label: string; value: string; onChange(value: string): void; rows?: number; maxLength?: number; placeholder?: string; disabled?: boolean; markdown?: boolean }) {
  const id = useId(), voice = useContext(VoiceContext)!, latest = useRef({ value, onChange }), [preview, setPreview] = useState(false);
  latest.current = { value, onChange };
  const cancel = useRef(voice.cancel); cancel.current = voice.cancel;
  useEffect(() => () => cancel.current(id), [id]);
  const active = voice.id === id, busy = !!voice.phase;
  useEffect(() => { if (disabled) cancel.current(id); }, [disabled, id]);
  return <div className="collab-input"><div className="collab-row"><label htmlFor={id}>{label}</label><div className="collab-actions">
    {markdown && <button type="button" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? '编辑' : '预览'}</button>}
    <button type="button" aria-label={`${active && voice.phase === '正在录音' ? '结束' : '语音输入'}：${label}`} disabled={disabled || (busy && (!active || voice.phase !== '正在录音'))} onClick={() => active && voice.phase === '正在录音' ? voice.finish() : voice.start(id, text => { const next = latest.current.value + (latest.current.value ? '\n' : '') + text; latest.current.onChange(maxLength ? next.slice(0, maxLength) : next); })}>{active && voice.phase ? voice.phase === '正在录音' ? '结束录音' : voice.phase : '语音输入'}</button>
    {active && busy && <button type="button" onClick={() => voice.cancel(id)}>取消录音</button>}
  </div></div>
    {preview ? <CollabMarkdown>{value || '暂无内容'}</CollabMarkdown> : rows ? <textarea id={id} disabled={disabled} rows={rows} maxLength={maxLength} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} /> : <input id={id} disabled={disabled} maxLength={maxLength} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} />}
    {active && voice.error && <small role="alert" className="collab-error">{voice.error}</small>}
  </div>;
}
