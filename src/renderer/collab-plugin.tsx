import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { MAX_ATTACHMENT_BYTES, type CollabAttachment, type CollabDetail, type CollabInboxItem, type CollabPeer, type CollabTask, type ExecutionReport, type UsageCounts } from '../../services/relay/src/collab-types.ts';
import { collabSettings, MAX_COLLAB_MINUTES, type CollabRpcResult, type CollabRun, type CollabState } from '../shared/collab.ts';
import { CollabInput, CollabMarkdown, CollabVoiceProvider } from './collab-input.tsx';
import type { CollabGeneratedFile, CollabPublishMode } from '../shared/collab.ts';

declare const __DSH_COLLAB_CSS__: string;
export const name = 'dsh-p2p-collab';
export const inject = ['slots', 'connection', 'uiWorkspace'];
type Rpc = <T = any>(method: string, args?: object, signal?: AbortSignal) => Promise<T>;
type Source = { subscribe(fn: () => void): () => void; getSnapshot(): CollabState | null; refresh(): Promise<void> };
type Context = {
  connection: { rpc: { call(channel: string, method: string, payload: unknown, signal: AbortSignal): Promise<CollabRpcResult> } };
  uiWorkspace: { openSession(id: string): void };
  slots: { inject(name: string, factory: () => unknown): unknown; register(spec: object, component: any): unknown };
  effect(factory: () => (() => void), label?: string): unknown;
};
type Draft = { operationId: string; title: string; body: string; acceptance: string; tags: string; kind: 'message' | 'solution'; verification: string; limitations: string; attachments: CollabAttachment[]; generatedFiles?: CollabGeneratedFile[]; runId?: string; reportSnapshot?: string; replaces?: string };
const freshDraft = (): Draft => ({ operationId: crypto.randomUUID(), title: '', body: '', acceptance: '', tags: '', kind: 'message', verification: '', limitations: '', attachments: [] });
const statusText: Record<string, string> = { open: '待解决', review: '待验收', resolved: '已解决', closed: '已关闭', preparing: '准备中', running: '运行中', completed: '已完成', stopped: '已停止', error: '失败', working: '正在处理', waiting: '等待补充', submitted: '已提交', withdrawn: '已退出' };
const eventText: Record<string, string> = { 'task.created': '发布了任务', 'task.updated': '更新了任务', 'reply.created': '有新回复', 'solution.submitted': '有新解决方案', 'solution.accepted': '方案已被采纳', 'participation.updated': '参与进度更新' };
const date = (time: number) => new Date(time).toLocaleString();
const who = (peers: CollabPeer[], id: string) => `${peers.find(p => p.id === id)?.nickname ?? '协作节点'} · ${id.slice(0, 6)}`;
const errorText: Record<string, string> = { collaboration_not_configured: '中继尚未启用协作服务，请先部署协作组件。', peer_not_joined: '协作身份尚未就绪，请重试本次操作。', author_required: '只有任务发布者可以执行此操作。', task_changed: '任务已更新，请刷新详情后重试。', task_not_open: '任务已结束，需要发布者重新开放。', access_revoked: '此设备的协作访问已撤销。', operation_conflict: '该提交的内容已变化，请重新检查并发布。', storage_quota: '附件存储配额已满，请在正文中提供下载链接。', peer_suspended: '此节点已暂停访问。', attachment_too_large: '附件过大，单个文件最多 8 MiB。请在正文中提供下载链接。', payload_too_large: '上传内容过大，请改为在正文中提供下载链接。', request_too_large: '上传内容过大，请改为在正文中提供下载链接。' };
const fileSize = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MiB` : `${(size / 1024).toFixed(1)} KiB`;
function Text({ children }: { children: string }) {
  return <CollabMarkdown>{children}</CollabMarkdown>;
}

function useDraft(rpc: Rpc, key: string) {
  const [value, setRawValue] = useState<Draft>(freshDraft), [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined), pending = useRef(Promise.resolve());
  const setValue: Dispatch<SetStateAction<Draft>> = update => setRawValue(old => ({ ...(typeof update === 'function' ? update(old) : update), operationId: crypto.randomUUID() }));
  const persist = (next: Draft | null) => { const write = pending.current.then(() => rpc<void>('draft-put', { key, value: next })); pending.current = write.catch(() => {}); return write; };
  useEffect(() => {
    let active = true; setReady(false);
    void rpc<Draft | null>('draft-get', { key }).then(saved => { if (active) { setRawValue(saved ?? freshDraft()); setReady(true); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [rpc, key]);
  useEffect(() => {
    if (!ready) return;
    timer.current = setTimeout(() => { void persist(value).catch(e => setError(e.message)); }, 250);
    return () => clearTimeout(timer.current);
  }, [rpc, key, value, ready]);
  const save = async () => { clearTimeout(timer.current); await persist(value); };
  const clear = async () => { clearTimeout(timer.current); await persist(null); setRawValue(freshDraft()); };
  return { value, setValue, ready, error, save, clear };
}

function Report({ report }: { report: ExecutionReport }) {
  const names: [keyof UsageCounts, string][] = [['uncachedInputTokens', '未缓存输入'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'], ['outputTokens', '输出'], ['reasoningTokens', '推理（输出内）'], ['totalTokens', '总 Token']];
  const count = (n: number | null) => n === null ? '未提供' : n.toLocaleString();
  return <details className="collab-report"><summary>执行信息与 Token 用量 · {report.usage.status === 'complete' ? '完整统计' : report.usage.status === 'partial' ? '统计不完整' : '用量不可用'}</summary>
    <p>DSH {report.client.appVersion} · 运行时 {report.client.runtimeVersion} · {report.client.platform} / {report.client.arch} · {(Math.max(0, report.finishedAt - report.startedAt) / 1000).toFixed(1)} 秒</p>
    <p>{report.usage.sessions} 个会话 · {report.usage.attempts} 次模型调用 · 客户端运行记录上报</p>
    <div className="collab-table-scroll"><table><thead><tr><th>模型</th>{names.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>
      {report.usage.routes.map((r, i) => <tr key={i}><td>{r.provider} / {r.model}</td>{names.map(([key]) => <td key={key}>{count(r[key])}</td>)}</tr>)}
      <tr><th>合计</th>{names.map(([key]) => <td key={key}>{count(report.usage.totals[key])}</td>)}</tr>
    </tbody></table></div>
  </details>;
}
function Attachment({ file, rpc, onError }: { file: CollabAttachment; rpc: Rpc; onError(message: string): void }) {
  const [busy, setBusy] = useState(false), [preview, setPreview] = useState('');
  const previewUrl = useRef(''), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }; }, []);
  const load = async (showImage: boolean) => {
    if (showImage && preview) { URL.revokeObjectURL(previewUrl.current); previewUrl.current = ''; setPreview(''); return; }
    setBusy(true); onError('');
    try {
      const result = await rpc('download', { id: file.id }), raw = atob(result.data);
      if (raw.length !== file.size || raw.length > MAX_ATTACHMENT_BYTES) throw new Error('附件大小校验失败。');
      const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      if ([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') !== file.sha256) throw new Error('附件校验失败。');
      if (!active.current) return;
      const signature = Array.from(bytes.slice(0, 12), b => String.fromCharCode(b)).join('');
      const imageType = signature.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : /^GIF8[79]a/.test(signature) ? 'image/gif' : signature.startsWith('RIFF') && signature.slice(8) === 'WEBP' ? 'image/webp' : '';
      if (showImage && !imageType) throw new Error('此文件不支持图片预览，可以直接下载。');
      const url = URL.createObjectURL(new Blob([bytes], { type: showImage ? imageType : 'application/octet-stream' }));
      if (showImage) { previewUrl.current = url; setPreview(url); }
      else { const a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
    } catch (error) { if (active.current) onError(error instanceof Error ? error.message : '附件下载失败'); } finally { if (active.current) setBusy(false); }
  };
  return <div className="collab-file"><div className="collab-actions"><button type="button" disabled={busy} onClick={() => { void load(false); }}>{busy ? '读取中…' : file.name} <small>{fileSize(file.size)}</small></button>
    {/\.(png|jpe?g|gif|webp)$/i.test(file.name) && <button type="button" disabled={busy} aria-label={'预览图片 ' + file.name} onClick={() => { void load(true); }}>{preview ? '收起图片' : '预览图片'}</button>}</div>
    {preview && <img className="collab-image" src={preview} alt={file.name} />}
  </div>;
}
function Files({ files, rpc, onError }: { files: CollabAttachment[]; rpc: Rpc; onError(message: string): void }) {
  return <div className="collab-files">{files.map(file => <Attachment key={file.id} file={file} rpc={rpc} onError={onError} />)}</div>;
}
function GeneratedFile({ file, runId, rpc, onError }: { file: CollabGeneratedFile; runId: string; rpc: Rpc; onError(message: string): void }) {
  const read: Rpc = () => rpc('generated-file', { runId, fileId: file.id });
  return <Attachment file={file} rpc={read} onError={onError} />;
}
function Upload({ files, onChange, rpc, onError, disabled, onBusyChange, reservedCount = 0 }: { files: CollabAttachment[]; onChange(files: CollabAttachment[]): void; rpc: Rpc; onError(message: string): void; disabled: boolean; onBusyChange(busy: boolean): void; reservedCount?: number }) {
  const [busy, setBusy] = useState(false), input = useRef<HTMLInputElement>(null);
  const upload = async (selected: FileList | null) => {
    if (!selected?.length || busy || disabled) return;
    const added: CollabAttachment[] = [];
    try {
      onError('');
      if (files.length + reservedCount + selected.length > 8) throw new Error('一次最多附带 8 个文件，更多文件请在正文中提供下载链接。');
      // Validate the entire selection before reading or uploading any of it.
      for (const file of Array.from(selected)) {
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`“${file.name}”（${fileSize(file.size)}）过大，单个附件最多 8 MiB。请将文件上传到可访问的存储位置，并在正文中提供下载链接。`);
        if (!file.size) throw new Error(`“${file.name}”内容为空，请选择其他文件。`);
      }
      setBusy(true); onBusyChange(true);
      for (const file of Array.from(selected)) {
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file); });
        added.push(await rpc<CollabAttachment>('upload', { operationId: crypto.randomUUID(), name: file.name, data }));
      }
    } catch (error) { onError(error instanceof Error ? error.message : '上传失败'); }
    finally { if (added.length) onChange([...files, ...added]); setBusy(false); onBusyChange(false); if (input.current) input.current.value = ''; }
  };
  return <div className="collab-upload"><input ref={input} type="file" multiple hidden disabled={disabled || busy} aria-label="选择图片或附件" onChange={e => { void upload(e.target.files); }} /><button type="button" disabled={disabled || busy || files.length + reservedCount >= 8} onClick={() => input.current?.click()}>{busy ? '上传中…' : '添加图片或附件'}</button>
    <small className="collab-file-hint">每个文件最多 8 MiB，每次最多 8 个。超过限制请在正文中提供下载链接。</small>
    {files.map(file => <span key={file.id}>{file.name} <small>{fileSize(file.size)}</small><button type="button" aria-label={'移除 ' + file.name} disabled={disabled || busy} onClick={() => onChange(files.filter(f => f.id !== file.id))}>×</button></span>)}
  </div>;
}
function NewTask({ rpc, onClose, onCreated }: { rpc: Rpc; onClose(): void; onCreated(id: string): void }) {
  const draft = useDraft(rpc, 'new-task'), d = draft.value;
  const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState('');
  const field = (key: keyof Draft, value: string) => draft.setValue(v => ({ ...v, [key]: value }));
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await draft.save();
      const task = await rpc<CollabTask>('create', { operationId: d.operationId, title: d.title, description: d.body, acceptance: d.acceptance, tags: d.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean), attachments: d.attachments.map(a => a.id) });
      await draft.clear(); onCreated(task.id);
    } catch (e) { setError(e instanceof Error ? e.message : '发布失败，草稿已保留。'); } finally { setBusy(false); }
  };
  if (!draft.ready) return <section className="collab-card" aria-label="发布任务"><button onClick={onClose}>返回</button><p role="status">{draft.error || '正在读取本机草稿…'}</p></section>;
  return <section className="collab-card collab-compose" aria-label="发布任务"><div className="collab-row"><h2>发布任务</h2><button onClick={onClose}>返回</button></div>
    <p className="collab-muted">内容将对协作空间成员可见。请选择需要共享的信息和附件。</p>
    <CollabInput label="问题详情" disabled={busy || !draft.ready} rows={7} markdown maxLength={49152} placeholder="描述你要解决的问题，支持 Markdown、代码和链接。标题可自动取正文第一行。" value={d.body} onChange={value => field('body', value)} />
    <details className="collab-optional"><summary>补充信息（可选）</summary>
      <CollabInput label="标题" disabled={busy} maxLength={200} value={d.title} onChange={value => field('title', value)} />
      <CollabInput label="验收要求" disabled={busy} rows={3} markdown maxLength={12000} value={d.acceptance} onChange={value => field('acceptance', value)} />
      <CollabInput label="标签" disabled={busy} maxLength={200} placeholder="用逗号分隔，如 Python、调试" value={d.tags} onChange={value => field('tags', value)} />
    </details>
    <Upload files={d.attachments} onChange={attachments => draft.setValue(v => ({ ...v, attachments }))} rpc={rpc} onError={setError} disabled={busy} onBusyChange={setUploading} />
    {(error || draft.error) && <p role="alert" className="collab-error">{error || draft.error}</p>}
    <div className="collab-row"><small>草稿保存在本机；支持 Markdown、代码和链接。</small><button className="collab-primary" disabled={busy || uploading || !draft.ready || !d.body.trim()} onClick={() => { void submit(); }}>{busy ? '发布中…' : '发布任务'}</button></div>
  </section>;
}
function TaskDetail({ taskId, rpc, state, openSession, onBack }: { taskId: string; rpc: Rpc; state: CollabState; openSession(id: string): void; onBack(): void }) {
  const [detail, setDetail] = useState<CollabDetail>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [run, setRun] = useState<CollabRun>(), [instruction, setInstruction] = useState('');
  const [replyOffset, setReplyOffset] = useState(0), [history, setHistory] = useState<CollabTask[]>();
  const [edit, setEdit] = useState<{ revision: number; title: string; description: string; acceptance: string; tags: string }>();
  const draft = useDraft(rpc, 'task:' + taskId), d = draft.value;
  const imported = useRef(new Set<string>());
  const importRun = (value: CollabRun) => {
    imported.current.add(value.id);
    draft.setValue(v => ({ ...v, kind: value.mode === 'solve' ? 'solution' : 'message', body: value.submission?.body ?? value.output ?? '', verification: value.submission?.verification ?? '', limitations: value.submission?.limitations ?? '', generatedFiles: value.submission?.files ?? [], runId: value.id, reportSnapshot: value.reportSnapshot }));
  };
  useEffect(() => {
    if (draft.ready && run?.status === 'completed' && run.publishMode === 'review' && !run.submittedReplyId && run.submission && !imported.current.has(run.id) && !d.body && !d.attachments.length && d.runId !== run.id) importRun(run);
  }, [draft.ready, run, d.body, d.runId]);
  const refresh = () => setRevision(n => n + 1);
  useEffect(() => { if (run?.publication?.status === 'published') refresh(); }, [run?.publication?.replyId]);
  useEffect(() => {
    let active = true;
    void rpc<CollabDetail>('detail', { taskId, offset: replyOffset }).then(value => { if (active) { setDetail(value); void rpc('read', { taskId, through: value.cursor }).catch(() => {}); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [rpc, taskId, state.cursor, revision, replyOffset]);
  const activeRun = state.runs.find(r => r.taskId === taskId && ['running', 'preparing'].includes(r.status));
  const currentRunId = activeRun?.id ?? d.runId ?? state.runs.find(r => r.taskId === taskId)?.id;
  useEffect(() => {
    if (!currentRunId) { setRun(undefined); return; }
    let active = true;
    const read = () => { void rpc<CollabRun>('run', { runId: currentRunId }).then(value => { if (active) setRun(value); }).catch(e => { if (active) setError(e.message); }); };
    read(); const timer = setInterval(read, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [rpc, currentRunId]);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); refresh(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); } };
  const submit = () => action(async () => {
    if (!detail) return;
    await draft.save();
    await rpc('reply', { operationId: d.operationId, taskId, kind: d.kind, body: d.body, baseRevision: detail.task.revision, attachments: d.attachments.map(a => a.id), generatedFiles: d.generatedFiles?.map(file => file.id) ?? [], ...(d.replaces ? { replaces: d.replaces } : {}),
      ...(d.runId ? { runId: d.runId, reportSnapshot: d.reportSnapshot } : {}),
      ...(d.kind === 'solution' ? { solution: { verification: d.verification, limitations: d.limitations } } : {}) });
    await draft.clear(); setReplyOffset(Math.floor(detail.task.replyCount / 50) * 50);
  });
  const start = (mode: 'reply' | 'solve') => action(async () => {
    await draft.save();
    const value = await rpc<CollabRun>('start', { operationId: crypto.randomUUID(), taskId, mode, instruction }); setRun(value);
  });
  if (!detail) return <div className="collab-card"><button onClick={onBack}>返回列表</button><p role={error ? 'alert' : 'status'}>{error || '正在读取任务详情…'}</p></div>;
  const t = detail.task;
  return <div className="collab-detail" data-collab-detail={taskId}>
    <div className="collab-row"><button onClick={onBack}>← 返回列表</button><button onClick={refresh}>刷新详情</button></div>
    <section className="collab-card"><div className="collab-row"><span className={'collab-status ' + t.status}>{statusText[t.status]}</span><small>版本 {t.revision} · {date(t.createdAt)}</small></div>
      <h1>{t.title}</h1><p className="collab-muted">{who(detail.peers, t.authorId)}</p><div className="collab-tags">{t.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
      <Text>{t.description}</Text>{t.acceptance && <div className="collab-acceptance"><strong>验收要求</strong><Text>{t.acceptance}</Text></div>}
      <Files files={detail.attachments} rpc={rpc} onError={setError} />
      <div className="collab-actions"><button disabled={busy} onClick={() => { void action(() => rpc('follow', { taskId, following: !t.following })); }}>{t.following ? '取消关注' : '关注任务'}</button>
        {state.settings.publishMode !== 'manual' && <><button disabled={busy || !!activeRun} onClick={() => { void start('reply'); }}>一键 AI 回复</button>
        <button className="collab-primary" disabled={busy || !!activeRun || ['resolved', 'closed'].includes(t.status)} onClick={() => { void start('solve'); }}>一键 AI 求解并提交</button></>}
        {t.authorId === state.peer.id && <button disabled={busy} onClick={() => { void action(() => rpc('update', { taskId, operationId: crypto.randomUUID(), revision: t.revision, status: ['closed', 'resolved'].includes(t.status) ? 'open' : 'closed' })); }}>{['closed', 'resolved'].includes(t.status) ? '重新开放' : '关闭任务'}</button>}
        {t.authorId === state.peer.id && <button disabled={busy} onClick={() => setEdit({ revision: t.revision, title: t.title, description: t.description, acceptance: t.acceptance, tags: t.tags.join(', ') })}>编辑任务</button>}
        <button onClick={() => { if (history) setHistory(undefined); else void action(async () => setHistory((await rpc('history', { taskId })).revisions)); }}>修改记录</button>
      </div>
      {state.settings.publishMode !== 'manual' && <><p className="collab-muted">{state.settings.publishMode === 'auto' ? '当前为 AI 自动发布：完成后自动发布正文和本次生成的附件。' : '当前为 AI 生成人审核后发布：完成后可编辑正文和附件，再发布。'}</p><details className="collab-optional"><summary>给 AI 的补充要求（可选）</summary><CollabInput label="补充要求" rows={3} maxLength={12000} value={instruction} onChange={setInstruction} disabled={busy || !!activeRun} /></details></>}
      {detail.participants.length > 0 && <p className="collab-muted">{detail.participants.map(p => `${who(detail.peers, p.peerId)}：${statusText[p.status]}`).join('；')}</p>}
    </section>
    {edit && <section className="collab-card collab-compose" aria-label="编辑任务"><h2>编辑任务 · 版本 {edit.revision}</h2>
      <CollabInput label="标题" maxLength={200} value={edit.title} onChange={title => setEdit({ ...edit, title })} />
      <CollabInput label="问题详情" rows={6} markdown maxLength={49152} value={edit.description} onChange={description => setEdit({ ...edit, description })} />
      <CollabInput label="验收要求" rows={3} markdown maxLength={12000} value={edit.acceptance} onChange={acceptance => setEdit({ ...edit, acceptance })} />
      <CollabInput label="标签" maxLength={200} value={edit.tags} onChange={tags => setEdit({ ...edit, tags })} />
      <div className="collab-actions"><button onClick={() => setEdit(undefined)}>取消</button><button disabled={busy} onClick={() => { void action(async () => { await rpc('update', { taskId, operationId: crypto.randomUUID(), ...edit, tags: edit.tags.split(/[,，]/).map(v => v.trim()).filter(Boolean) }); setEdit(undefined); setHistory(undefined); }); }}>保存新版本</button></div>
    </section>}
    {history && <section className="collab-card"><h2>最近 20 个版本</h2>{history.map(item => <details key={item.revision}><summary>版本 {item.revision} · {date(item.updatedAt)} · {item.title}</summary><Text>{item.description}</Text><Text>{item.acceptance}</Text></details>)}</section>}
    {run && <section className="collab-card collab-run"><div className="collab-row"><strong>本机{run.mode === 'solve' ? '求解' : '回复'} · {statusText[run.status]}</strong><button onClick={() => openSession(run.sessionId)}>查看本机会话 ↗</button></div>
      {run.stopReason && <p>{run.stopReason}</p>}{run.error && <p className="collab-error">{run.error}</p>}
      {run.submissionError && <p className="collab-error">{run.submissionError}，未自动发布。可检查本机会话或编辑正文后手动发布。</p>}
      {run.submittedReplyId && <p role="status">✓ 已审核发布</p>}
      {run.publication?.status === 'published' ? <p role="status">✓ AI 已自动发布正文和附件</p> : run.publication?.status === 'error' ? <><p role="alert" className="collab-error">自动发布失败：{run.publication.error}</p><button disabled={busy} onClick={() => { void action(async () => setRun(await rpc('publish-run', { runId: run.id }))); }}>重试自动发布</button></> : null}
      {['running', 'preparing'].includes(run.status) ? <button disabled={busy} onClick={() => { void action(() => rpc('cancel', { runId: run.id })); }}>停止本机任务</button> : run.output && !run.publication && d.runId !== run.id && <button disabled={busy} onClick={() => importRun(run)}>编辑 AI 结果与附件</button>}
    </section>}
    <section className="collab-thread" aria-label="讨论和解决方案"><h2>讨论与解决方案 <small>{t.replyCount}</small></h2>
      {detail.replies.length === 0 && <p className="collab-muted">还没有回复。可以先交流信息，或在本机尝试解决。</p>}
      {detail.replies.map(reply => <article key={reply.id} className={'collab-card collab-reply ' + (reply.kind === 'solution' ? 'solution' : '')}>
        <div className="collab-row"><strong>{who(detail.peers, reply.authorId)}</strong><small>{date(reply.createdAt)}</small></div>
        <p className="collab-muted">{reply.actor === 'dsh' ? 'DSH 生成' : '用户回复'} · {reply.kind === 'solution' ? '解决方案' : '讨论消息'}{reply.replaces ? ' · 修订版本' : ''}{reply.baseRevision !== t.revision ? ` · 基于任务版本 ${reply.baseRevision}` : ''}</p>
        <Text>{reply.body}</Text>
        {reply.solution && <><strong>验证结果</strong><Text>{reply.solution.verification}</Text>{reply.solution.limitations && <><strong>限制与未验证部分</strong><Text>{reply.solution.limitations}</Text></>}{reply.solution.report ? <Report report={reply.solution.report} /> : <p className="collab-muted">手动提交，未附带 DSH 运行用量。</p>}</>}
        <Files files={reply.attachments} rpc={rpc} onError={setError} />
        {reply.kind === 'solution' && reply.authorId === state.peer.id && !['closed', 'resolved'].includes(t.status) && <button onClick={() => draft.setValue({ ...freshDraft(), kind: 'solution', body: reply.body, verification: reply.solution!.verification, limitations: reply.solution!.limitations, attachments: reply.attachments, replaces: reply.id })}>修订这个方案</button>}
        {t.acceptedReplyId === reply.id ? <p className="collab-accepted">✓ 发布者已采纳</p> : reply.kind === 'solution' && t.authorId === state.peer.id && t.status === 'review' && <button disabled={busy} onClick={() => { void action(() => rpc('accept', { taskId, operationId: crypto.randomUUID(), revision: t.revision, replyId: reply.id })); }}>采纳方案并标记已解决</button>}
      </article>)}
      <div className="collab-pagination"><button disabled={replyOffset === 0} onClick={() => setReplyOffset(n => Math.max(0, n - 50))}>上一页讨论</button><span>第 {Math.floor(replyOffset / 50) + 1} 页</span><button disabled={!detail.hasMore} onClick={() => setReplyOffset(n => n + 50)}>下一页讨论</button></div>
    </section>
    <section className="collab-card collab-compose" aria-label="回复任务"><div className="collab-actions"><button aria-pressed={d.kind === 'message'} onClick={() => draft.setValue(v => ({ ...v, kind: 'message' }))}>回复消息</button><button aria-pressed={d.kind === 'solution'} onClick={() => draft.setValue(v => ({ ...v, kind: 'solution' }))}>提交解决方案</button></div>
      {d.replaces && <p>此提交会保留原方案并发布修订版本。<button onClick={() => draft.setValue(v => ({ ...v, replaces: undefined }))}>改为独立方案</button></p>}
      <CollabInput label={d.kind === 'solution' ? '解决方法与步骤' : '回复内容'} disabled={busy || !draft.ready} rows={6} markdown maxLength={49152} value={d.body} onChange={body => draft.setValue(v => ({ ...v, body }))} />
      {d.kind === 'solution' && <details className="collab-optional"><summary>验证与限制（可选，正文已包含时无需重复填写）</summary><CollabInput label="实际验证与结果" disabled={busy} rows={3} markdown maxLength={16000} value={d.verification} onChange={verification => draft.setValue(v => ({ ...v, verification }))} /><CollabInput label="限制与未验证部分" disabled={busy} rows={2} markdown maxLength={8000} value={d.limitations} onChange={limitations => draft.setValue(v => ({ ...v, limitations }))} /></details>}
      {!!d.generatedFiles?.length && <div className="collab-upload" aria-label="AI 生成附件">{d.generatedFiles.map(file => <span key={file.id}><GeneratedFile file={file} runId={d.runId!} rpc={rpc} onError={setError} /><button disabled={busy} aria-label={'移除 ' + file.name} onClick={() => draft.setValue(v => ({ ...v, generatedFiles: v.generatedFiles?.filter(f => f.id !== file.id) }))}>×</button></span>)}</div>}
      <Upload files={d.attachments} reservedCount={d.generatedFiles?.length ?? 0} onChange={attachments => draft.setValue(v => ({ ...v, attachments }))} rpc={rpc} onError={setError} disabled={busy || !draft.ready} onBusyChange={setUploading} />
      {d.runId && run?.id === d.runId && run.report && <><p className="collab-muted">本次发布将附带以下运行信息。发布前请检查正文及附件。</p><Report report={run.report} /></>}
      {d.runId && run?.id === d.runId && run.reportSnapshot !== d.reportSnapshot && <button type="button" disabled={busy} onClick={() => draft.setValue(value => ({ ...value, reportSnapshot: run.reportSnapshot }))}>更新运行信息（保留正文和附件）</button>}
      {(error || draft.error) && <p role="alert" className="collab-error">{error || draft.error}</p>}
      <div className="collab-row"><small>{d.runId ? '来源：本机 DSH 草稿' : '来源：用户填写'} · 草稿保存在本机</small><button className="collab-primary" disabled={busy || uploading || !draft.ready || !d.body.trim() || (d.kind === 'solution' && ['resolved', 'closed'].includes(t.status))} onClick={() => { void submit(); }}>{busy ? '提交中…' : d.kind === 'solution' ? '发布方案' : '发送回复'}</button></div>
    </section>
  </div>;
}

function Settings({ state, rpc }: { state: CollabState; rpc: Rpc }) {
  const [nickname, setNickname] = useState(state.peer.nickname), [maxTokens, setMaxTokens] = useState(String(state.settings.maxTokens)), [maxMinutes, setMaxMinutes] = useState(String(state.settings.maxMinutes)), [message, setMessage] = useState('');
  const [publishMode, setPublishMode] = useState<CollabPublishMode>(state.settings.publishMode ?? 'review');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); setMessage(''); try { if (!maxTokens.trim() || !maxMinutes.trim()) throw new Error('请填写 Token 阈值和运行时间；填 0 表示不限制。'); const settings = collabSettings(Number(maxTokens), Number(maxMinutes), publishMode); await rpc('profile', { nickname, ...settings }); setMessage('已保存'); } catch (e) { setMessage(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); } };
  return <section className="collab-card collab-compose" aria-label="协作设置"><h2>协作设置</h2><p>节点 ID：<code>{state.peer.id}</code></p><p className="collab-muted">升级和重新启用插件会保留此身份。协作内容对同一空间成员及中继管理员可见。</p>
    <fieldset className="collab-modes"><legend>发布方式</legend>{([['manual', '手动发布', '自己填写正文、选择附件后发布。'], ['review', 'AI 生成人审核后发布', 'AI 生成正文和附件，你审核、修改后发布。'], ['auto', 'AI 自动发布', '点击一键 AI 回复或求解后，完成即自动发布正文和所列附件。']] as const).map(([mode, label, description]) => <label key={mode}><input type="radio" name="collab-publish-mode" value={mode} checked={publishMode === mode} onChange={() => setPublishMode(mode)} /><span>{label}<small>{description}</small></span></label>)}</fieldset>
    <small>模式保存后用于新启动的任务；运行中的任务保留启动时的模式。</small>
    <CollabInput label="昵称" maxLength={48} value={nickname} onChange={setNickname} disabled={busy} />
    <label>单次任务 Token 停止阈值<input aria-label="单次任务 Token 停止阈值" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={maxTokens} onChange={e => setMaxTokens(e.target.value)} /></label><small>支持亿级 Token，填 0 表示不限制。按已完成调用的用量检查；进行中的单次请求可能超出阈值。</small>
    <label>最长运行时间（分钟）<input aria-label="最长运行时间（分钟）" type="number" min={0} max={MAX_COLLAB_MINUTES} step={1} value={maxMinutes} onChange={e => setMaxMinutes(e.target.value)} /></label><small>支持多天运行，例如 10,080 分钟为 7 天。填 0 表示不限制；两项都为 0 时，由你手动停止任务。</small>
    <p className="collab-muted">同时运行 1 个协作任务。浏览、关注和接收消息不会调用模型。</p><button disabled={busy || !nickname.trim()} className="collab-primary" onClick={() => { void save(); }}>{busy ? '保存中…' : '保存设置'}</button><p role="status">{message}</p>
  </section>;
}

function CollabPage({ source, rpc, openSession }: { source: Source; rpc: Rpc; openSession(id: string): void }) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [view, setView] = useState('all'), [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [selected, setSelected] = useState(''), [creating, setCreating] = useState(false), [nonce, setNonce] = useState(0);
  const [catalog, setCatalog] = useState<{ tasks: CollabTask[]; peers: CollabPeer[]; hasMore: boolean }>({ tasks: [], peers: [], hasMore: false });
  const [inbox, setInbox] = useState<{ items: CollabInboxItem[]; hasMore: boolean }>({ items: [], hasMore: false });
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [syncError, setSyncError] = useState(''), [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const read = () => { if (document.visibilityState !== 'hidden') void rpc('sync').then(() => source.refresh()).catch(() => {}); };
    read(); const timer = setInterval(read, 60000);
    window.addEventListener('focus', read); document.addEventListener('visibilitychange', read);
    return () => { clearInterval(timer); window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', read); };
  }, [rpc, source]);
  const refresh = async () => {
    setRefreshing(true); setSyncError('');
    try { await rpc('sync'); await source.refresh(); }
    catch (e) { setSyncError(`获取新消息失败：${e instanceof Error ? e.message : '请稍后重试'}。已有内容和草稿已保留。`); }
    finally { setNonce(n => n + 1); setRefreshing(false); }
  };
  useEffect(() => {
    if (!state || selected || creating || view === 'settings') return;
    let active = true; setLoading(true); setError('');
    const load = view === 'inbox' ? rpc('inbox', { offset }).then(v => { if (active) setInbox(v); }) : rpc('catalog', { view, query, offset }).then(v => { if (active) setCatalog(v); });
    void load.catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rpc, view, query, offset, selected, creating, nonce, state?.cursor]);
  const chooseView = (next: string) => { setView(next); setOffset(0); setSelected(''); setCreating(false); };
  return <CollabVoiceProvider rpc={rpc}><main className="collab" data-testid="collab-page"><header className="collab-header"><div><h1>协作空间</h1><p>{state ? `${state.peer.nickname} · ${state.peer.id.slice(0, 6)}` : '正在加载本机身份…'}</p></div><div className="collab-actions">{state?.lastSyncAt && <small>消息更新于 {new Date(state.lastSyncAt).toLocaleTimeString()}</small>}<button disabled={refreshing} onClick={() => { void refresh(); }}>{refreshing ? '刷新中…' : '刷新消息'}</button><button className="collab-primary" onClick={() => { setCreating(true); setSelected(''); }}>发布任务</button></div></header>
    <nav className="collab-tabs" aria-label="协作空间视图">{[['all', '任务广场'], ['mine', '我发布的'], ['following', '我关注的'], ['participating', '我参与的'], ['inbox', `消息${state?.unread ? ` (${state.unread})` : ''}`], ['settings', '设置']].map(([key, label]) => <button key={key} aria-selected={view === key && !creating} onClick={() => chooseView(key)}>{label}</button>)}</nav>
    <div className="collab-content">{syncError && <p className="collab-banner" role="alert">{syncError}</p>}
      {!state ? <p>正在加载…</p> : creating ? <NewTask rpc={rpc} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); setSelected(id); }} /> : selected ? <TaskDetail key={selected} taskId={selected} rpc={rpc} state={state} openSession={openSession} onBack={() => setSelected('')} /> : view === 'settings' ? <Settings state={state} rpc={rpc} /> : <>
        <div className="collab-row">{view !== 'inbox' ? <div className="collab-search"><CollabInput label="搜索任务" placeholder="搜索任务标题、内容或标签" maxLength={120} value={query} onChange={value => { setQuery(value); setOffset(0); }} /></div> : <h2>消息</h2>}{view === 'inbox' && <button onClick={() => { void rpc('read', { through: state.cursor }).then(() => { setNonce(n => n + 1); void source.refresh(); }).catch(e => setError(e.message)); }}>全部标记已读</button>}</div>
        {error && <p role="alert" className="collab-error">{errorText[error] ?? error}</p>}{loading && <p role="status" className="collab-muted">正在同步…</p>}
        {view === 'inbox' ? <div className="collab-list">{inbox.items.map(item => <button className={'collab-card collab-task ' + (item.read ? '' : 'unread')} key={item.id} onClick={() => setSelected(item.taskId)}><strong>{item.title}</strong><span>{eventText[item.kind] ?? '任务有更新'}</span><small>{date(item.at)}</small></button>)}{!loading && !inbox.items.length && <p className="collab-empty">暂无消息。发布、回复或关注任务后，更新会显示在这里。</p>}</div> : <div className="collab-list">{catalog.tasks.map(task => <button className="collab-card collab-task" key={task.id} onClick={() => setSelected(task.id)}><div className="collab-row"><span className={'collab-status ' + task.status}>{statusText[task.status]}</span><small>{date(task.updatedAt)}</small></div><h2>{task.title}</h2><p>{task.description.slice(0, 180)}</p><div className="collab-row"><span>{who(catalog.peers, task.authorId)}</span><small>{task.replyCount} 条回复 · {task.solutionCount} 个方案{task.following ? ' · 已关注' : ''}</small></div></button>)}{!loading && !catalog.tasks.length && <p className="collab-empty">暂无匹配任务。可以发布问题，也可以调整筛选。</p>}</div>}
        <div className="collab-pagination"><button disabled={offset === 0 || loading} onClick={() => setOffset(n => Math.max(0, n - 50))}>上一页</button><span>第 {Math.floor(offset / 50) + 1} 页</span><button disabled={loading || !(view === 'inbox' ? inbox.hasMore : catalog.hasMore)} onClick={() => setOffset(n => n + 50)}>下一页</button></div>
      </>}
    </div>
  </main></CollabVoiceProvider>;
}
function CollabIcon({ size = 18 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="6" cy="6" r="3" /><circle cx="18" cy="7" r="3" /><circle cx="12" cy="18" r="3" /><path d="m9 6 6 1M7 9l4 6m6-5-4 5" /></svg>; }

export function apply(ctx: Context) {
  const abort = new AbortController();
  let snapshot: CollabState | null = null, pending = false, stateRevision = 0;
  const listeners = new Set<() => void>();
  const rpc: Rpc = async (method, args = {}, signal) => {
    const result = await ctx.connection.rpc.call(method.startsWith('speech/') ? '/api' : '/desktop-collab', method, { args }, signal ? AbortSignal.any([abort.signal, signal]) : abort.signal);
    if (!result.ok) throw new Error(errorText[result.error.message] ?? result.error.message);
    if (method === 'profile' && !abort.signal.aborted) { stateRevision++; snapshot = result.value; for (const fn of listeners) fn(); }
    return result.value;
  };
  const source: Source = { subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSnapshot: () => snapshot,
    async refresh() { if (pending || abort.signal.aborted) return; pending = true; const revision = stateRevision; try { const value = await rpc<CollabState>('state'); if (!abort.signal.aborted && revision === stateRevision) { snapshot = value; for (const fn of listeners) fn(); } } catch {} finally { pending = false; } } };
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = __DSH_COLLAB_CSS__; document.head.append(style);
    void source.refresh(); const timer = setInterval(() => { void source.refresh(); }, 1500);
    return () => { abort.abort(); clearInterval(timer); listeners.clear(); style.remove(); };
  }, 'collab: state and styles');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'p2p-collab', inject: () => ({ source, rpc, openSession: (id: string) => ctx.uiWorkspace.openSession(id) }) }, CollabPage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'p2p-collab', order: 12, label: () => '协作空间' }, CollabIcon));
}
