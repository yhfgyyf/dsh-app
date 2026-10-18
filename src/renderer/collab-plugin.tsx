import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { MAX_ATTACHMENT_BYTES, type CollabAttachment, type CollabDetail, type CollabInboxItem, type CollabPeer, type CollabReply, type CollabTask, type ExecutionReport, type UsageCounts } from '../../services/relay/src/collab-types.ts';
import { collabSettings, MAX_COLLAB_MINUTES, type CollabRpcResult, type CollabRun, type CollabState } from '../shared/collab.ts';
import { CollabInput, CollabMarkdown, CollabVoiceProvider } from './collab-input.tsx';
import type { CollabExecutionMode, CollabGeneratedFile, CollabPublishMode, CollabLocalAttempt as LocalAttempt } from '../shared/collab.ts';
import { CollabRelaySettings, draftWriters, initializeRelayProfiles } from './collab-relay-settings.tsx';

declare const __DSH_COLLAB_CSS__: string;
export const name = 'dsh-p2p-collab';
export const inject = ['slots', 'connection', 'uiWorkspace'];
type Rpc = <T = any>(method: string, args?: object, signal?: AbortSignal) => Promise<T>;
type Source = { subscribe(fn: () => void): () => void; getSnapshot(): CollabState | null; refresh(): Promise<void> };
type Context = {
  connection: { rpc: { call(channel: string, method: string, payload: unknown, signal: AbortSignal): Promise<CollabRpcResult> } };
  uiWorkspace: { openSession(id: string): void };
  slots: { inject(name: string, factory: () => unknown): () => void; register(spec: object, component: any): unknown };
  effect(factory: () => (() => void), label?: string): unknown;
};
type MessageType = 'discussion' | 'progress' | 'solution';
type Draft = { operationId: string; title: string; body: string; acceptance: string; tags: string; kind: 'message' | 'solution'; messageType?: MessageType; replyTo?: string; verification: string; limitations: string; attachments: CollabAttachment[]; generatedFiles?: CollabGeneratedFile[]; runId?: string; reportSnapshot?: string; replaces?: string; baseRevision?: number; contextReplyCount?: number };
const freshDraft = (): Draft => ({ operationId: crypto.randomUUID(), title: '', body: '', acceptance: '', tags: '', kind: 'message', verification: '', limitations: '', attachments: [] });
const relayUpgradeMessage = '中继待升级：暂不支持新版 AI 参与、消息分类和任务完成。现有任务与回复仍可使用。';
const supportsWorkflow = (detail: CollabDetail) => Number.isSafeInteger(detail.task.specRevision) && detail.task.specRevision > 0 && Array.isArray(detail.attempts) && Array.isArray(detail.validations);
const supportsConversation = (detail: CollabDetail) => (detail as CollabDetail & { capabilities?: { conversationWorkflow?: number } }).capabilities?.conversationWorkflow === 1;
const messageTypes = [['discussion', '讨论'], ['progress', '进展'], ['solution', '方案']] as const;
const messageType = (reply: { kind: string; messageType?: string }): MessageType => reply.kind === 'solution' ? 'solution' : reply.messageType === 'progress' ? 'progress' : 'discussion';
const statusText: Record<string, string> = { open: '进行中', review: '进行中', resolved: '已解决', closed: '已关闭', completed: '参与已结束', error: '需要处理', working: '正在处理', waiting: '等待新信息', ready: '待你发布', paused: '已暂停', budget: '额度已用完', submitted: '已发布', withdrawn: '已退出' };
const runStatusText: Record<string, string> = { preparing: '本轮准备中', running: '本轮运行中', completed: '本轮已完成', stopped: '本轮已停止', error: '本轮需要处理' };
const publishModes = [['review', '审核后发布', 'AI 起草后由你检查、修改正文和附件，再决定发布；下一轮由你开始。'], ['auto', '自动发布', '有实质新增才公开正文和附件，没有新增时安静等待。']] as const;
const visiblePublishMode = (mode?: CollabPublishMode) => mode === 'auto' ? 'auto' : 'review';
const publishText = (mode?: CollabPublishMode) => mode === 'manual' ? '旧设置：仅保存在本机' : publishModes.find(value => value[0] === visiblePublishMode(mode))![1];
const historicalAttempt = (attempt: { status: string }) => ['withdrawn', 'completed'].includes(attempt.status);
function reveal(element: HTMLElement | null) {
  if (!element) return;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
  element.scrollIntoView({ block: 'start' }); element.focus({ preventScroll: true });
}
const eventText: Record<string, string> = { 'task.created': '发布了任务', 'task.updated': '更新了任务要求', 'reply.created': '有新回复', 'solution.submitted': '有新方案', 'solution.accepted': '任务已解决', 'task.completed': '任务已解决', 'validation.created': '有新验证结果', 'participation.updated': '参与进度更新', 'attempt.updated': '参与进度更新' };
const date = (time: number) => new Date(time).toLocaleString();
const who = (peers: CollabPeer[], id: string) => `${peers.find(p => p.id === id)?.nickname ?? '协作节点'} · ${id.slice(0, 6)}`;
const errorText: Record<string, string> = { collaboration_not_supported: '此中继尚不支持协作认证，请先升级私有中继和协作服务；手机远程连接仍可使用。', identity_recovery_unavailable: '旧协作身份没有恢复凭据，请让中继管理员核对原身份并恢复设备绑定。历史记录会保留。', identity_recovery_required: '本机缺少原协作身份的恢复凭据，请恢复本机身份备份，或联系中继管理员处理。', identity_recovery_invalid: '本机恢复凭据与原协作身份不一致，请核对身份备份或联系中继管理员。', identity_device_active: '原设备注册仍然有效，请先在原设备解除注册，或联系中继管理员核对绑定。', identity_recovery_unsupported: '私有中继尚不支持身份恢复校验，请先升级私有中继服务，再重试。', collaboration_not_configured: '中继尚未启用协作服务，请先部署协作组件。', identity_conflict: '本机协作身份与中继登记不一致。更新插件不会自动重置身份，请先诊断并核对绑定后再处理。', peer_not_joined: '协作身份尚未就绪，请重试本次操作。', author_required: '只有任务发布者可以执行此操作。', task_changed: '任务已更新，请刷新详情后重试。', task_not_open: '任务已结束，需要发布者重新开放。', requirements_need_revalidation: '任务已验收，请先重新开放，再修改要求并重新验证。', solution_replaced: '此候选已有修订版本，请刷新详情后验证最新候选。', valid_verification_required: '请先选择针对当前候选和当前要求的通过验证，再正式验收。', access_revoked: '此设备的协作访问已撤销。', operation_conflict: '该提交的内容已变化，请重新检查并发布。', storage_quota: '附件存储配额已满，请在正文中提供下载链接。', peer_suspended: '此节点已暂停访问。', attachment_too_large: '附件过大，单个文件最多 8 MiB。请在正文中提供下载链接。', payload_too_large: '上传内容过大，请改为在正文中提供下载链接。', request_too_large: '上传内容过大，请改为在正文中提供下载链接。' };
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
  const latest = useRef({ value, ready }); latest.current = { value, ready };
  useEffect(() => {
    const flush = () => latest.current.ready ? persist(latest.current.value) : pending.current;
    draftWriters.add(flush);
    return () => { draftWriters.delete(flush); clearTimeout(timer.current); void flush().catch(() => {}); };
  }, [rpc, key]);
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
  const clear = async () => { clearTimeout(timer.current); await persist(null); const value = freshDraft(); latest.current = { value, ready: false }; setRawValue(value); };
  const markContextRead = (contextReplyCount: number) => setRawValue(old => ({ ...old, contextReplyCount }));
  return { value, setValue, ready, error, save, clear, markContextRead };
}

function Report({ report }: { report: ExecutionReport }) {
  const names: [keyof UsageCounts, string][] = [['uncachedInputTokens', '未缓存输入'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'], ['outputTokens', '输出'], ['reasoningTokens', '推理（输出内）'], ['totalTokens', '总 Token']];
  const count = (n: number | null) => n === null ? '未提供' : n.toLocaleString();
  return <details className="collab-report"><summary>执行信息与 Token 用量 · {report.usage.status === 'complete' ? '完整统计' : report.usage.status === 'partial' ? '统计不完整' : '用量不可用'}</summary>
    <p>{report.client.harness === 'codex' || report.client.appVersion.startsWith('Codex ') ? '' : 'DSH '}{report.client.appVersion} · 运行时 {report.client.runtimeVersion} · {report.client.platform} / {report.client.arch} · {(Math.max(0, report.finishedAt - report.startedAt) / 1000).toFixed(1)} 秒</p>
    <p>{report.usage.sessions} 个会话 · {report.usage.attempts} {report.client.usageUnit === 'turn' || report.client.appVersion.startsWith('Codex ') ? '轮 Codex 用量汇总' : '次模型调用'} · 客户端运行记录上报</p>
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
    <CollabInput label="完成目标" disabled={busy} rows={3} markdown maxLength={12000} placeholder="写出期望结果；如需验证，可在这里补充标准。" value={d.acceptance} onChange={value => field('acceptance', value)} />
    <details className="collab-optional"><summary>补充信息（可选）</summary>
      <CollabInput label="标题" disabled={busy} maxLength={200} value={d.title} onChange={value => field('title', value)} />
      <CollabInput label="标签" disabled={busy} maxLength={200} placeholder="用逗号分隔，如 Python、调试" value={d.tags} onChange={value => field('tags', value)} />
    </details>
    <Upload files={d.attachments} onChange={attachments => draft.setValue(v => ({ ...v, attachments }))} rpc={rpc} onError={setError} disabled={busy} onBusyChange={setUploading} />
    {(error || draft.error) && <p role="alert" className="collab-error">{error || draft.error}</p>}
    <div className="collab-row"><small>草稿保存在本机；支持 Markdown、代码和链接。</small><button className="collab-primary" disabled={busy || uploading || !draft.ready || !d.body.trim()} onClick={() => { void submit(); }}>{busy ? '发布中…' : '发布任务'}</button></div>
  </section>;
}
function MyParticipation({ attempt, rpc, ended, occupied, supported, owner, onChanged }: { attempt: LocalAttempt; rpc: Rpc; ended: boolean; occupied: boolean; supported: boolean; owner: boolean; onChanged(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const [instruction, setInstruction] = useState(attempt.direction ?? ''), [executionMode, setExecutionMode] = useState(attempt.executionMode);
  const [publishMode, setPublishMode] = useState<CollabPublishMode>(visiblePublishMode(attempt.publishMode));
  const [addingBudget, setAddingBudget] = useState(false), [tokens, setTokens] = useState('0'), [minutes, setMinutes] = useState('0');
  const active = attempt.desiredState === 'active', withdrawn = attempt.desiredState === 'withdrawn';
  const finished = historicalAttempt(attempt);
  useEffect(() => { setInstruction(attempt.direction ?? ''); }, [attempt.direction]);
  useEffect(() => { setExecutionMode(attempt.executionMode); setPublishMode(visiblePublishMode(attempt.publishMode)); }, [attempt.executionMode, attempt.publishMode]);
  const changed = instruction !== (attempt.direction ?? '') || executionMode !== attempt.executionMode || publishMode !== attempt.publishMode;
  const act = async (method: string) => {
    if (!supported && ['attempt-resume', 'attempt-configure'].includes(method)) { setError(relayUpgradeMessage); return; }
    setBusy(true); setError(''); setSaved('');
    try {
      const args: Record<string, unknown> = { attemptId: attempt.id };
      if (method === 'attempt-configure') Object.assign(args, { instruction, publishMode, executionMode });
      if (method === 'attempt-resume') {
        if (changed) await rpc('attempt-configure', { attemptId: attempt.id, instruction, publishMode, executionMode });
        if (addingBudget || attempt.status === 'budget') {
          const extraTokens = Number(tokens), extraMinutes = Number(minutes);
          if (!tokens.trim() || !minutes.trim() || !Number.isSafeInteger(extraTokens) || extraTokens < 0 || !Number.isSafeInteger(extraMinutes) || extraMinutes < 0 || extraMinutes > MAX_COLLAB_MINUTES) throw new Error('追加额度须为非负整数。');
          if (attempt.status === 'budget' && !extraTokens && !extraMinutes) throw new Error('额度已用完，请填写追加额度后继续。');
          args.additionalTokens = extraTokens; args.additionalMinutes = extraMinutes;
        }
      }
      await rpc(method, args); setAddingBudget(false); setTokens('0'); setMinutes('0');
      if (method === 'attempt-configure') setSaved('已保存，将用于下一轮。');
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  };
  const label = attempt.status === 'waiting' && attempt.publishMode !== 'auto' ? '待你继续' : statusText[attempt.status] ?? attempt.status;
  return <article className="collab-attempt" data-attempt-id={attempt.id} tabIndex={-1}>
    <div className="collab-row"><strong>{owner ? '发布方 · 处理进展' : '参与方 · 推进任务'}</strong><span className={'collab-status ' + attempt.status}>{label}</span></div>
    <p className="collab-muted">{attempt.executionMode === 'continuous' ? '持续参与' : '参与一次'} · {publishText(attempt.publishMode)}</p>
    {attempt.baseRevision !== attempt.currentTaskRevision && <p className="collab-banner">任务要求已更新，下一轮会核对最新要求。</p>}
    {attempt.waitReason && <p>{attempt.waitReason}</p>}
    {attempt.status === 'paused' && <p className="collab-banner">已暂停，新消息会保留，只有你恢复后才会继续。</p>}
    {attempt.status === 'budget' && <p className="collab-banner">累计额度已用完，追加后才能继续。</p>}
    {attempt.syncError && <p role="alert" className="collab-error">参与状态同步失败：{attempt.syncError}。本机记录已保留。</p>}
    {!supported && !finished && <p className="collab-banner">中继待升级，本机记录保留，仍可暂停或退出。</p>}
    {!withdrawn && !finished && !ended && <>
      <details className="collab-optional collab-resume">
        <summary>下一轮指令与参与设置</summary>
        <CollabInput label="下一轮指令（不公开）" value={instruction} onChange={value => { setInstruction(value); setSaved(''); }} rows={3} maxLength={12000} disabled={busy || !supported} />
        <div className="collab-control-options"><label>参与方式<select aria-label="参与方式" value={executionMode} onChange={event => { setExecutionMode(event.target.value as CollabExecutionMode); setSaved(''); }} disabled={busy || !supported}><option value="manual">参与一次</option><option value="continuous">持续参与</option></select></label><label>回复发布<select aria-label="回复发布" value={publishMode} onChange={event => { setPublishMode(event.target.value as CollabPublishMode); setSaved(''); }} disabled={busy || !supported}>{publishModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        <small>{publishModes.find(value => value[0] === publishMode)![2]} 修改指令不会改变正在运行的内容。</small>
        <label className="collab-check"><input type="checkbox" checked={addingBudget || attempt.status === 'budget'} disabled={busy || attempt.status === 'budget'} onChange={event => setAddingBudget(event.target.checked)} />追加参与额度</label>
        {(addingBudget || attempt.status === 'budget') && <div className="collab-budget-inputs"><label>追加 Token<input aria-label="追加 Token" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={tokens} onChange={event => setTokens(event.target.value)} /></label><label>追加分钟<input aria-label="追加分钟" type="number" min={0} max={MAX_COLLAB_MINUTES} step={1} value={minutes} onChange={event => setMinutes(event.target.value)} /></label><small>追加到原累计上限；原本不限的项目仍为不限。</small></div>}
        <div className="collab-actions"><button disabled={busy || !supported || !changed} onClick={() => { void act('attempt-configure'); }}>保存参与设置</button></div>
        {occupied && <small>本机已有任务正在处理，结束后才能开始下一轮。</small>}
        {saved && <p role="status">{saved}</p>}
      </details>
      <div className="collab-actions"><button disabled={busy || occupied || !supported} className="collab-primary" onClick={() => { void act('attempt-resume'); }}>开始下一轮</button>{active && <button disabled={busy} onClick={() => { void act('attempt-pause'); }}>暂停参与</button>}<button disabled={busy} onClick={() => { void act('attempt-withdraw'); }}>结束参与</button></div>
    </>}
    <details className="collab-optional"><summary>参与详情与用量</summary>
      <p>下一步：{attempt.nextStep || '尚未确定'}</p><p>待处理消息 {(attempt.pendingEvents ?? []).length} 条 · 已计入 {(attempt.usedTokens ?? 0).toLocaleString()} Token / {attempt.limits.maxTokens ? attempt.limits.maxTokens.toLocaleString() : '不限'} · {Math.ceil((attempt.usedMillis ?? 0) / 60000)} / {attempt.limits.maxMinutes || '不限'} 分钟</p>
      <p>共 {attempt.runIds.length} 轮 · 要求版本 {attempt.baseRevision} · {date(attempt.updatedAt)}</p>
      {attempt.publicDirection && <p>此前公开方向：{attempt.publicDirection}</p>}
      {!!attempt.decisions?.length && <details><summary>最近的消息评估</summary>{attempt.decisions.slice(-5).map((decision, i) => <p key={i}>{decision.reason || decision.decision} <small>· {date(decision.at)}</small></p>)}</details>}
      {!!attempt.eventArchive?.length && <details><summary>中继历史重置前的待处理消息</summary>{attempt.eventArchive.map((item, index) => <div key={index}><p>{date(item.at)} · {item.reason}</p>{item.pendingEvents.map(event => <p key={event.id}>{eventText[event.kind] ?? '任务更新'} · {date(event.at)}</p>)}{item.decisions.map((decision, i) => <p key={i}>{decision.reason || decision.decision}</p>)}</div>)}</details>}
    </details>
    {error && <p role="alert" className="collab-error">{error}</p>}
  </article>;
}

function TaskDetail({ taskId, initialEvent, rpc, state, openSession, onBack, onWorkflowSupport }: { taskId: string; initialEvent?: CollabInboxItem; rpc: Rpc; state: CollabState; openSession(id: string): void; onBack(): void; onWorkflowSupport(supported: boolean): void }) {
  const [detail, setDetail] = useState<CollabDetail>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [uploading, setUploading] = useState(false), [instruction, setInstruction] = useState('');
  const [run, setRun] = useState<CollabRun>(), [selectedRunId, setSelectedRunId] = useState(''), [pendingImport, setPendingImport] = useState<CollabRun>();
  const [executionMode, setExecutionMode] = useState<CollabExecutionMode>(state.settings.executionMode ?? 'manual');
  const [publishMode, setPublishMode] = useState<CollabPublishMode>(visiblePublishMode(state.settings.publishMode));
  const [replyOffset, setReplyOffset] = useState(0), [filter, setFilter] = useState<MessageType | 'all'>('all'), [history, setHistory] = useState<CollabTask[]>();
  const [targetSubject, setTargetSubject] = useState(initialEvent?.subjectId ?? ''), [targetRequest, setTargetRequest] = useState(0), [locatedSubject, setLocatedSubject] = useState('');
  const [pendingDraft, setPendingDraft] = useState<Draft>(), [completing, setCompleting] = useState<{ baseRevision: number; taskRevision: number; operationId: string }>(), [completionSummary, setCompletionSummary] = useState('');
  const [edit, setEdit] = useState<{ revision: number; title: string; description: string; acceptance: string; tags: string }>();
  const root = useRef<HTMLDivElement>(null), openedEvent = useRef<number>(), navigated = useRef(''), imported = useRef(new Set<string>());
  const draftContext = useRef<number>();
  const draft = useDraft(rpc, 'task:' + taskId), d = draft.value;
  const taskRuns = state.runs.filter(r => r.taskId === taskId).sort((a, b) => b.startedAt - a.startedAt);
  const occupiedRun = state.runs.find(r => ['running', 'preparing'].includes(r.status)), activeRun = taskRuns.find(r => ['running', 'preparing'].includes(r.status));
  const attempts = (state.attempts ?? []).filter(value => value.taskId === taskId).sort((a, b) => b.startedAt - a.startedAt);
  const currentAttempt = attempts.find(value => !historicalAttempt(value));
  const currentRunId = selectedRunId || activeRun?.id || taskRuns[0]?.id;
  const hasDraft = !!(d.body.trim() || d.attachments.length || d.generatedFiles?.length);
  const refresh = () => setRevision(n => n + 1);
  const selectSubject = (id: string) => { setFilter('all'); setTargetSubject(id); setTargetRequest(value => value + 1); setLocatedSubject(''); };
  const chooseFilter = (value: MessageType | 'all') => { setFilter(value); setReplyOffset(0); setTargetSubject(''); };
  const importRun = (value: CollabRun) => {
    imported.current.add(value.id);
    const type: MessageType = value.submission?.messageType ?? (value.mode === 'solve' ? !value.attemptId || value.checkpoint?.action === 'ready' ? 'solution' : 'progress' : 'discussion');
    draft.setValue(v => ({ ...v, kind: type === 'solution' ? 'solution' : 'message', messageType: type, replyTo: value.submission?.replyTo, body: value.submission?.body ?? value.output ?? '', verification: value.submission?.verification ?? '', limitations: value.submission?.limitations ?? '', generatedFiles: value.submission?.files ?? [], runId: value.id, reportSnapshot: value.reportSnapshot, baseRevision: value.taskRevision, contextReplyCount: detail?.task.replyCount, replaces: type === 'solution' ? value.replacesReplyId : undefined }));
    setPendingImport(undefined);
    requestAnimationFrame(() => reveal(root.current?.querySelector('#collab-composer') ?? null));
  };
  const replaceDraft = (next: Draft) => { draft.setValue(next); setPendingDraft(undefined); requestAnimationFrame(() => reveal(root.current?.querySelector('#collab-composer') ?? null)); };
  const prepareDraft = (next: Draft) => {
    if (hasDraft) { setPendingDraft(next); requestAnimationFrame(() => reveal(root.current?.querySelector('#collab-composer') ?? null)); }
    else replaceDraft(next);
  };
  useEffect(() => {
    if (draft.ready && run?.status === 'completed' && run.id === taskRuns[0]?.id && run.publishMode === 'review' && !run.submittedReplyId && run.submission && !imported.current.has(run.id) && !hasDraft && d.runId !== run.id) importRun(run);
  }, [draft.ready, run, hasDraft, d.runId]);
  useEffect(() => {
    if (d.contextReplyCount !== undefined) draftContext.current = d.contextReplyCount;
    else if (!hasDraft) draftContext.current = undefined;
    else if (detail && draftContext.current === undefined) draftContext.current = detail.task.replyCount;
  }, [detail, hasDraft, d.contextReplyCount]);
  useEffect(() => { if (run?.publication?.status === 'published' || run?.submittedReplyId) refresh(); }, [run?.publication?.replyId, run?.submittedReplyId]);
  useEffect(() => { if (run?.completion?.status === 'completed') refresh(); }, [run?.completion?.status]);
  useEffect(() => {
    let active = true;
    void rpc<CollabDetail>('detail', { taskId, offset: replyOffset, ...(filter !== 'all' ? { messageType: filter } : {}), ...(targetSubject ? { subjectId: targetSubject } : {}) }).then(value => { if (active) { setDetail(value); onWorkflowSupport(supportsWorkflow(value)); setReplyOffset(value.replyOffset ?? replyOffset); setLocatedSubject(targetSubject); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [rpc, taskId, state.cursor, revision, replyOffset, filter, targetSubject, targetRequest, onWorkflowSupport]);
  useEffect(() => {
    if (!detail || (targetSubject && locatedSubject !== targetSubject)) return;
    if (!targetSubject && (!initialEvent || initialEvent.subjectId || openedEvent.current === initialEvent.id)) return;
    const navigation = `${targetSubject}:${targetRequest}`;
    if (navigated.current === navigation) return;
    const reply = detail.replies.find(value => value.id === targetSubject) ?? detail.replies.find(value => (detail.validations ?? []).some(validation => validation.id === targetSubject && validation.replyId === value.id));
    const element = reply ? root.current?.querySelector<HTMLElement>(`[data-reply-id="${reply.id}"]`) : targetSubject && attempts.some(value => value.id === targetSubject) ? root.current?.querySelector<HTMLElement>(`[data-attempt-id="${targetSubject}"]`) : root.current?.querySelector<HTMLElement>('#collab-overview');
    if (!element) return;
    root.current?.querySelectorAll<HTMLElement>('[data-highlighted]').forEach(value => delete value.dataset.highlighted);
    if (reply) element.dataset.highlighted = 'true';
    const frame = requestAnimationFrame(() => {
      navigated.current = navigation; reveal(element);
      if (initialEvent && openedEvent.current !== initialEvent.id && (initialEvent.subjectId ?? '') === targetSubject) {
        openedEvent.current = initialEvent.id;
        if (supportsWorkflow(detail)) void rpc('read', { eventIds: [initialEvent.id] }).catch(e => { openedEvent.current = undefined; setError(`标记消息已读失败：${e.message}`); });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [detail, locatedSubject, targetSubject, targetRequest, initialEvent, rpc, state.attempts]);
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
    if (d.replaces && !supportsWorkflow(detail)) throw new Error('中继待升级：暂不能修订已有方案，草稿已保留。');
    await draft.save();
    const type = messageType(d);
    await rpc('reply', { operationId: d.operationId, taskId, kind: type === 'solution' ? 'solution' : 'message', body: d.body, baseRevision: d.baseRevision ?? detail.task.specRevision ?? detail.task.revision, attachments: d.attachments.map(a => a.id), generatedFiles: d.generatedFiles?.map(file => file.id) ?? [], ...(d.replaces ? { replaces: d.replaces } : {}),
      ...(supportsConversation(detail) ? { messageType: type, ...(d.replyTo ? { replyTo: d.replyTo } : {}) } : {}),
      ...(d.runId ? { runId: d.runId, reportSnapshot: d.reportSnapshot } : {}), ...(type === 'solution' ? { solution: { verification: d.verification, limitations: d.limitations } } : {}) });
    await draft.clear(); setFilter('all'); setTargetSubject(''); setReplyOffset(Math.floor(detail.task.replyCount / 50) * 50);
  });
  const start = () => action(async () => {
    if (!detail) return;
    await draft.save();
    const modern = supportsConversation(detail), execution = modern ? executionMode : 'manual';
    collabSettings(state.settings.maxTokens, state.settings.maxMinutes, publishMode, execution);
    const value = await rpc<CollabRun>('start', { operationId: crypto.randomUUID(), taskId, mode: modern ? 'solve' : 'reply', instruction, executionMode: execution, publishMode });
    setSelectedRunId(value.id); setRun(value);
  });
  if (!detail) return <div className="collab-card"><button onClick={onBack}>返回列表</button><p role={error ? 'alert' : 'status'}>{error || '正在读取任务详情…'}</p></div>;
  const t = detail.task, specRevision = t.specRevision ?? t.revision, ended = ['resolved', 'closed'].includes(t.status), owner = t.authorId === state.peer.id;
  const workflowSupported = supportsWorkflow(detail), conversationSupported = supportsConversation(detail);
  const invalidBudget = executionMode === 'continuous' && !state.settings.maxTokens && !state.settings.maxMinutes;
  const draftType = messageType(d), draftReplyCount = d.contextReplyCount ?? draftContext.current, draftHasUpdates = hasDraft && draftReplyCount !== undefined && t.replyCount > draftReplyCount;
  const availableResult = run && run.output && !run.publication && !run.submittedReplyId && d.runId !== run.id && !['running', 'preparing'].includes(run.status);
  return <div ref={root} className="collab-detail" data-collab-detail={taskId}>
    <div className="collab-row"><button onClick={onBack}>← 返回列表</button><button onClick={refresh}>刷新详情</button></div>
    {!conversationSupported && <p className="collab-banner" role="status">{relayUpgradeMessage}</p>}
    {!workflowSupported && initialEvent && !initialEvent.read && <p className="collab-banner">此中继暂不支持逐条已读；本条消息保留未读，可返回消息列表显式全部标记已读。</p>}
    <section id="collab-overview" tabIndex={-1} className="collab-card collab-contract" aria-label="任务要求">
      <div className="collab-row"><span className={'collab-status ' + t.status}>{statusText[t.status]}</span><small>要求版本 {specRevision} · {date(t.createdAt)}</small></div>
      <h1>{t.title}</h1><p className="collab-muted">发布者：{who(detail.peers, t.authorId)}</p><div className="collab-tags">{t.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
      <Text>{t.description}</Text><div className="collab-acceptance"><strong>完成目标</strong><Text>{t.acceptance || '尚未约定'}</Text></div>
      <Files files={detail.attachments} rpc={rpc} onError={setError} />
      <div className="collab-actions"><button disabled={busy} onClick={() => { void action(() => rpc('follow', { taskId, following: !t.following })); }}>{t.following ? '取消关注' : '关注任务'}</button><small>关注只接收通知，不启动 AI。</small>
        {owner && !ended && conversationSupported && <button className="collab-primary" disabled={busy} onClick={() => setCompleting(completing ? undefined : { baseRevision: specRevision, taskRevision: t.revision, operationId: crypto.randomUUID() })}>标记解决</button>}
        {owner && <button disabled={busy} onClick={() => { void action(() => rpc('update', { taskId, operationId: crypto.randomUUID(), revision: t.revision, status: ended ? 'open' : 'closed' })); }}>{ended ? '重新开放' : '关闭任务'}</button>}
        {owner && <button disabled={busy} onClick={() => setEdit({ revision: t.revision, title: t.title, description: t.description, acceptance: t.acceptance, tags: t.tags.join(', ') })}>编辑任务</button>}
        <button onClick={() => { if (history) setHistory(undefined); else void action(async () => setHistory((await rpc('history', { taskId })).revisions)); }}>修改记录</button>
      </div>
      {completing && !ended && <div className="collab-start" aria-label="完成任务"><CollabInput label="完成说明" rows={3} markdown maxLength={12000} value={completionSummary} onChange={value => { setCompletionSummary(value); setCompleting({ ...completing, operationId: crypto.randomUUID() }); }} placeholder="说明结果，以及如何满足当前任务要求。" disabled={busy} />{(completing.baseRevision !== specRevision || completing.taskRevision !== t.revision) && <p className="collab-banner">任务要求已有更新，请重新核对后打开完成操作。说明已保留。</p>}<div className="collab-actions"><button className="collab-primary" disabled={busy || !completionSummary.trim() || (completing.baseRevision !== specRevision || completing.taskRevision !== t.revision)} onClick={() => { void action(async () => { await rpc('complete', { taskId, ...completing, summary: completionSummary }); setCompleting(undefined); }); }}>确认解决</button><button disabled={busy} onClick={() => setCompleting(undefined)}>取消</button></div></div>}
    </section>
    {edit && <section className="collab-card collab-compose" aria-label="编辑任务"><h2>编辑任务 · 版本 {edit.revision}</h2>
      <CollabInput label="标题" maxLength={200} value={edit.title} onChange={title => setEdit({ ...edit, title })} />
      <CollabInput label="问题详情" rows={6} markdown maxLength={49152} value={edit.description} onChange={description => setEdit({ ...edit, description })} />
      <CollabInput label="完成目标" rows={3} markdown maxLength={12000} value={edit.acceptance} onChange={acceptance => setEdit({ ...edit, acceptance })} />
      <CollabInput label="标签" maxLength={200} value={edit.tags} onChange={tags => setEdit({ ...edit, tags })} />
      <div className="collab-actions"><button onClick={() => setEdit(undefined)}>取消</button><button disabled={busy} onClick={() => { void action(async () => { await rpc('update', { taskId, operationId: crypto.randomUUID(), ...edit, tags: edit.tags.split(/[,，]/).map(v => v.trim()).filter(Boolean) }); setEdit(undefined); setHistory(undefined); }); }}>保存新版本</button></div>
    </section>}
    {history && <section className="collab-card"><h2>最近 20 个版本</h2>{history.map(item => <details key={item.revision}><summary>要求版本 {item.specRevision ?? item.revision} · {date(item.updatedAt)} · {item.title}</summary><Text>{item.description}</Text><Text>{item.acceptance || '完成目标尚未约定'}</Text></details>)}</section>}
    <section id="collab-participation" tabIndex={-1} className="collab-card collab-participation" aria-label="本机参与"><div className="collab-row"><h2>{owner ? 'AI 帮我处理进展' : 'AI 参与任务'}</h2>{activeRun && <button onClick={() => openSession(activeRun.sessionId)}>查看处理会话 ↗</button>}</div>
      {currentAttempt ? <MyParticipation key={currentAttempt.id} attempt={currentAttempt} rpc={rpc} ended={ended} occupied={!!occupiedRun} supported={conversationSupported} owner={owner} onChanged={() => { setSelectedRunId(''); refresh(); }} /> : !ended && <div className="collab-start">
        <p className="collab-muted">{owner ? '接收有用回复、核对结果并继续处理你的任务。' : '结合任务和相关消息推进工作，分享有用进展或方案。'}</p>
        <div className="collab-control-options"><label>参与方式<select aria-label="本次参与方式" value={conversationSupported ? executionMode : 'manual'} onChange={event => setExecutionMode(event.target.value as CollabExecutionMode)} disabled={busy || !conversationSupported}><option value="manual">参与一次</option><option value="continuous">持续参与</option></select></label><label>回复发布<select aria-label="本次回复发布" value={publishMode} onChange={event => setPublishMode(event.target.value as CollabPublishMode)} disabled={busy}>{publishModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        <CollabInput label="本轮指令（不公开）" rows={3} maxLength={12000} placeholder={owner ? '例如：判断新增方案是否解决问题，验证后继续处理未完成部分。' : '例如：先复现问题，补充可验证的结果。'} value={instruction} onChange={setInstruction} disabled={busy || !!occupiedRun} />
        <small>{publishModes.find(value => value[0] === publishMode)![2]}</small>
        <details className="collab-optional"><summary>参考内容与额度</summary><p>每轮参考最新任务、本机已有结论和后续相关消息；指令只用于本机 AI。</p><p>累计上限：{state.settings.maxTokens ? `${state.settings.maxTokens.toLocaleString()} Token` : 'Token 不限'} · {state.settings.maxMinutes ? `${state.settings.maxMinutes} 分钟` : '时间不限'}，可在设置中调整。</p></details>
        <div className="collab-actions"><button className="collab-primary" disabled={busy || !!occupiedRun || (conversationSupported && invalidBudget)} onClick={() => { void start(); }}>{conversationSupported ? '开始参与' : 'AI 起草一次回复'}</button></div>
        {conversationSupported && invalidBudget && <p role="alert" className="collab-error">持续参与至少需要一项有限额度，请先在设置中填写 Token 或时间上限。</p>}
        {occupiedRun && <p role="status" className="collab-banner">本机正在处理“{occupiedRun.title}”，结束后才能开始。<button onClick={() => openSession(occupiedRun.sessionId)}>查看处理会话 ↗</button></p>}
      </div>}
      {run && <div className="collab-result" data-selected-run={run.id}>
        {['running', 'preparing'].includes(run.status) && <p role="status">{runStatusText[run.status]}</p>}
        {run.stopReason && <p>{run.stopReason}</p>}{run.error && <p role="alert" className="collab-error">{run.error}</p>}
        {run.submissionError && <p className="collab-error">{run.submissionError}，结果未发布，可检查处理会话后重新起草。</p>}
        {run.publicationSkipReason && <p className="collab-muted">{run.publicationSkipReason}</p>}
        {run.submittedReplyId && <p role="status">✓ 你已发布本轮回复。</p>}
        {d.runId === run.id && hasDraft && <button onClick={() => reveal(root.current?.querySelector('#collab-composer') ?? null)}>检查待发布回复</button>}
        {run.publication?.status === 'published' ? <p role="status">✓ AI 已自动发布正文和附件。</p> : run.publication?.status === 'error' ? <><p role="alert" className="collab-error">自动发布失败：{run.publication.error}</p><button disabled={busy} onClick={() => { void action(async () => setRun(await rpc('publish-run', { runId: run.id }))); }}>重试自动发布</button></> : null}
        {run.completion?.status === 'completed' ? <p role="status">✓ AI 已按完成说明标记任务解决。</p> : run.completion?.status === 'error' ? <><p role="alert" className="collab-error">自动完成失败：{run.completion.error}</p><button disabled={busy} onClick={() => { void action(async () => setRun(await rpc('publish-run', { runId: run.id }))); }}>重试自动完成</button></> : run.completion?.status === 'pending' ? <p role="status">正在提交任务完成说明…</p> : null}
        {owner && !ended && conversationSupported && run.publishMode !== 'auto' && run.checkpoint?.completion && <button onClick={() => { setCompletionSummary(run.checkpoint!.completion!.summary); setCompleting({ baseRevision: run.taskRevision, taskRevision: t.revision, operationId: crypto.randomUUID() }); reveal(root.current?.querySelector('#collab-overview') ?? null); }}>检查 AI 的完成建议</button>}
        {['running', 'preparing'].includes(run.status) && !run.attemptId && <button disabled={busy} onClick={() => { void action(() => rpc('cancel', { runId: run.id })); }}>停止本轮</button>}
        {availableResult && <div className="collab-actions"><span>本轮有可检查的回复。{hasDraft && '当前草稿已保留。'}</span><button disabled={busy || !draft.ready} onClick={() => { if (hasDraft) setPendingImport(run); else importRun(run); }}>查看并用作草稿</button></div>}
        {pendingImport?.id === run.id && <div className="collab-banner"><p>替换会使用所选结果的正文和生成附件，并保留手动添加的附件。</p><div className="collab-actions"><button onClick={() => importRun(pendingImport)}>替换当前草稿</button><button onClick={() => setPendingImport(undefined)}>保留当前草稿</button></div></div>}
      </div>}
      {(attempts.length > 1 || taskRuns.length > 0) && <details className="collab-run-history" aria-label="参与历史与日志"><summary>参与历史与日志</summary>
        {attempts.filter(value => value.id !== currentAttempt?.id).map(value => <details key={value.id}><summary>{date(value.startedAt)} · {statusText[value.status] ?? value.status}</summary><MyParticipation attempt={value} rpc={rpc} ended={ended} occupied={!!occupiedRun} supported={conversationSupported} owner={owner} onChanged={refresh} /></details>)}
        {taskRuns.map((item, index) => <div className="collab-history-row" key={item.id} data-run-id={item.id}><button aria-pressed={currentRunId === item.id} onClick={() => { setSelectedRunId(item.id); setPendingImport(undefined); }}>第 {taskRuns.length - index} 轮 · {runStatusText[item.status]} · {date(item.startedAt)}</button><button onClick={() => openSession(item.sessionId)}>查看会话 ↗</button></div>)}
        {run?.checkpoint && <p>{run.checkpoint.summary}</p>}
      </details>}
    </section>
    <section id="collab-discussion" tabIndex={-1} className="collab-thread" aria-label="任务消息"><div className="collab-row"><h2>消息 <small>{t.replyCount} 条</small></h2><button onClick={() => reveal(root.current?.querySelector('#collab-composer') ?? null)}>写回复</button></div>
      {conversationSupported && <div className="collab-actions collab-message-filter" aria-label="消息筛选">{([['all', '全部'], ...messageTypes] as const).map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => chooseFilter(value)}>{label}</button>)}</div>}
      {detail.replies.length === 0 && <p className="collab-muted">{filter === 'all' ? '还没有回复。可以交流信息，也可以让 AI 参与。' : '暂无此类消息。'}</p>}
      {detail.replies.map(reply => {
        const type = messageType(reply), replyTo = (reply as CollabReply & { replyTo?: string }).replyTo;
        const validations = (detail.validations ?? []).filter(value => value.replyId === reply.id);
        return <article key={reply.id} data-reply-id={reply.id} data-message-type={type} tabIndex={-1} className={'collab-card collab-reply ' + type}>
          <div className="collab-row"><strong>{who(detail.peers, reply.authorId)}{reply.authorId === t.authorId && <small> · 发布者</small>}</strong><small>{date(reply.createdAt)}</small></div>
          <div className="collab-actions collab-message-meta"><span className={'collab-message-type ' + type}>{messageTypes.find(value => value[0] === type)![1]}</span>{reply.actor === 'dsh' && <small>AI 辅助</small>}{t.acceptedReplyId === reply.id && <small>已采纳</small>}{reply.supersededBy && <small>已有新版</small>}</div>
          {replyTo && <button className="collab-reference" onClick={() => selectSubject(replyTo)}>↳ 查看引用的消息</button>}
          <Text>{reply.body}</Text><Files files={reply.attachments} rpc={rpc} onError={setError} />
          <div className="collab-actions">{conversationSupported && <button disabled={busy || !draft.ready} onClick={() => { draft.setValue(value => ({ ...value, replyTo: reply.id, contextReplyCount: value.contextReplyCount ?? t.replyCount })); reveal(root.current?.querySelector('#collab-composer') ?? null); }}>引用回复</button>}
            {reply.kind === 'solution' && reply.authorId === state.peer.id && !ended && !reply.supersededBy && workflowSupported && <button disabled={busy || !draft.ready} onClick={() => prepareDraft({ ...freshDraft(), kind: 'solution', messageType: 'solution', body: reply.body, verification: reply.solution?.verification ?? '', limitations: reply.solution?.limitations ?? '', attachments: reply.attachments, replaces: reply.id, baseRevision: specRevision, contextReplyCount: t.replyCount })}>更新方案</button>}
            {reply.replaces && <button onClick={() => selectSubject(reply.replaces!)}>查看上一版</button>}{reply.supersededBy && <button onClick={() => selectSubject(reply.supersededBy!)}>查看新版</button>}
          </div>
          <details className="collab-optional collab-message-details"><summary>消息详情</summary><p>基于要求版本 {reply.baseRevision}{reply.baseRevision !== specRevision ? ' · 任务要求已有更新' : ''}</p>
            {reply.solution?.verification && <><strong>验证说明</strong><Text>{reply.solution.verification}</Text></>}{reply.solution?.limitations && <><strong>限制与未验证部分</strong><Text>{reply.solution.limitations}</Text></>}{reply.solution?.report && <Report report={reply.solution.report} />}
            {validations.map(value => <details key={value.id} data-validation-id={value.id}><summary>历史验证：{value.outcome === 'passed' ? '通过' : value.outcome === 'failed' ? '失败' : '结论不充分'} · {who(detail.peers, value.authorId)}{value.baseRevision !== specRevision ? ' · 基于旧要求' : ''}</summary><p>{value.method} · {value.environment}</p><Text>{value.evidence}</Text></details>)}
          </details>
        </article>;
      })}
      <div className="collab-pagination"><button disabled={replyOffset === 0} onClick={() => { setTargetSubject(''); setReplyOffset(n => Math.max(0, n - 50)); }}>上一页消息</button><span>第 {Math.floor(replyOffset / 50) + 1} 页</span><button disabled={!detail.hasMore} onClick={() => { setTargetSubject(''); setReplyOffset(n => n + 50); }}>下一页消息</button></div>
    </section>
    <section id="collab-composer" tabIndex={-1} className="collab-card collab-compose" aria-label="回复任务"><div className="collab-actions" aria-label="回复类型">{messageTypes.filter(([value]) => conversationSupported || value !== 'progress').map(([value, label]) => <button key={value} aria-pressed={draftType === value} onClick={() => draft.setValue(v => ({ ...v, messageType: value, kind: value === 'solution' ? 'solution' : 'message', replaces: value === 'solution' ? v.replaces : undefined, baseRevision: v.baseRevision ?? specRevision }))}>{label}</button>)}</div>
      {pendingDraft && <div className="collab-banner" role="status"><p>当前草稿已有内容，替换后将使用所选方案的正文与附件。</p><button onClick={() => replaceDraft(pendingDraft)}>替换当前草稿</button><button onClick={() => setPendingDraft(undefined)}>保留当前草稿</button></div>}
      {d.replyTo && <div className="collab-actions collab-banner"><span>正在引用一条消息</span><button onClick={() => selectSubject(d.replyTo!)}>查看原消息</button><button onClick={() => draft.setValue(value => ({ ...value, replyTo: undefined }))}>取消引用</button></div>}
      {draftHasUpdates && <div className="collab-banner" role="status" data-draft-updates><p>有新消息，你的正文和附件已保留。发布前请核对并按需更新草稿。</p><div className="collab-actions"><button onClick={() => { chooseFilter('all'); setReplyOffset(Math.floor(Math.max(0, t.replyCount - 1) / 50) * 50); reveal(root.current?.querySelector('#collab-discussion') ?? null); }}>查看新消息</button><button onClick={() => draft.markContextRead(t.replyCount)}>已核对新消息</button></div></div>}
      {d.replaces && <p>此回复会更新已有方案并保留旧版。<button onClick={() => draft.setValue(v => ({ ...v, replaces: undefined }))}>改为独立方案</button></p>}
      {d.replaces && !workflowSupported && <p className="collab-banner">中继待升级，暂不能更新已有方案；草稿已保留。</p>}
      <CollabInput label="回复内容" disabled={busy || !draft.ready} rows={6} markdown maxLength={49152} value={d.body} onChange={body => draft.setValue(v => ({ ...v, body, baseRevision: v.baseRevision ?? specRevision, contextReplyCount: v.contextReplyCount ?? t.replyCount }))} />
      {d.baseRevision && d.baseRevision !== specRevision ? <p className="collab-banner">草稿基于要求版本 {d.baseRevision}，当前为版本 {specRevision}。请核对更新，原版本归属会保留。</p> : null}
      {draftType === 'solution' && <details className="collab-optional"><summary>补充验证与限制（可选）</summary><CollabInput label="实际验证与结果" disabled={busy} rows={3} markdown maxLength={16000} value={d.verification} onChange={verification => draft.setValue(v => ({ ...v, verification }))} /><CollabInput label="限制与未验证部分" disabled={busy} rows={2} markdown maxLength={8000} value={d.limitations} onChange={limitations => draft.setValue(v => ({ ...v, limitations }))} /></details>}
      {!!d.generatedFiles?.length && <div className="collab-upload" aria-label="AI 生成附件">{d.generatedFiles.map(file => <span key={file.id}>{d.runId && <GeneratedFile file={file} runId={d.runId} rpc={rpc} onError={setError} />}<button disabled={busy} aria-label={'移除 ' + file.name} onClick={() => draft.setValue(v => ({ ...v, generatedFiles: v.generatedFiles?.filter(f => f.id !== file.id) }))}>×</button></span>)}</div>}
      <Upload files={d.attachments} reservedCount={d.generatedFiles?.length ?? 0} onChange={attachments => draft.setValue(v => ({ ...v, attachments, contextReplyCount: v.contextReplyCount ?? t.replyCount }))} rpc={rpc} onError={setError} disabled={busy || !draft.ready} onBusyChange={setUploading} />
      {d.runId && run?.id === d.runId && run.report && <Report report={run.report} />}
      {d.runId && currentRunId !== d.runId && <button type="button" onClick={() => setSelectedRunId(d.runId!)}>查看草稿的生成记录</button>}
      {d.runId && run?.id === d.runId && run.reportSnapshot !== d.reportSnapshot && <button type="button" disabled={busy} onClick={() => draft.setValue(value => ({ ...value, reportSnapshot: run.reportSnapshot }))}>更新生成记录（保留正文和附件）</button>}
      {(error || draft.error) && <p role="alert" className="collab-error">{error || draft.error}</p>}
      <div className="collab-row"><small>草稿保存在本机{d.runId ? ' · AI 辅助生成，可自由修改' : ''}</small><button className="collab-primary" disabled={busy || uploading || !draft.ready || !d.body.trim() || (draftType === 'solution' && ended) || (!!d.replaces && !workflowSupported)} onClick={() => { void submit(); }}>{busy ? '发送中…' : '发送回复'}</button></div>
    </section>
  </div>;
}

function Settings({ state, rpc }: { state: CollabState; rpc: Rpc }) {
  const [nickname, setNickname] = useState(state.peer.nickname), [maxTokens, setMaxTokens] = useState(String(state.settings.maxTokens)), [maxMinutes, setMaxMinutes] = useState(String(state.settings.maxMinutes)), [message, setMessage] = useState('');
  const [publishMode, setPublishMode] = useState<CollabPublishMode>(visiblePublishMode(state.settings.publishMode));
  const [executionMode, setExecutionMode] = useState<CollabExecutionMode>(state.settings.executionMode ?? 'manual');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); setMessage(''); try { if (!maxTokens.trim() || !maxMinutes.trim()) throw new Error('请填写 Token 阈值和运行时间；填 0 表示不限制。'); const settings = collabSettings(Number(maxTokens), Number(maxMinutes), publishMode, executionMode); await rpc('profile', { nickname, ...settings }); setMessage('已保存'); } catch (e) { setMessage(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); } };
  return <section className="collab-card collab-compose" aria-label="协作设置"><h2>协作设置</h2><p>节点 ID：<code>{state.peer.id}</code></p><p className="collab-muted">升级和重新启用插件会保留此身份。协作内容对同一空间成员及中继管理员可见。</p>
    <fieldset className="collab-modes"><legend>默认参与方式</legend>{([['manual', '参与一次', '处理一轮后停止，由你决定是否继续。'], ['continuous', '持续参与', '在额度内处理任务和相关更新；审核后发布时，每轮由你继续。']] as const).map(([mode, label, description]) => <label key={mode}><input type="radio" name="collab-execution-mode" value={mode} checked={executionMode === mode} onChange={() => setExecutionMode(mode)} /><span>{label}<small>{description}</small></span></label>)}</fieldset>
    <fieldset className="collab-modes"><legend>默认发布方式</legend>{publishModes.map(([mode, label, description]) => <label key={mode}><input type="radio" name="collab-publish-mode" value={mode} checked={publishMode === mode} onChange={() => setPublishMode(mode)} /><span>{label}<small>{description}</small></span></label>)}</fieldset>
    <small>默认设置用于新参与，已有任务可在本机参与区单独修改。</small>
    <CollabInput label="昵称" maxLength={48} value={nickname} onChange={setNickname} disabled={busy} />
    <label>累计 Token 上限<input aria-label="累计 Token 上限" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={maxTokens} onChange={e => setMaxTokens(e.target.value)} /></label><small>同一任务各轮消耗累计。填 0 表示不限制；按已完成调用统计，进行中的单次请求可能超出阈值。</small>
    <label>累计时间上限（分钟）<input aria-label="累计时间上限（分钟）" type="number" min={0} max={MAX_COLLAB_MINUTES} step={1} value={maxMinutes} onChange={e => setMaxMinutes(e.target.value)} /></label><small>支持多天运行，填 0 表示不限制；持续参与至少需要一项有限额度。</small>
    <p className="collab-muted">本机同时处理一个任务。浏览和关注不会调用模型；暂停参与后，新消息会保留。</p><button disabled={busy || !nickname.trim()} className="collab-primary" onClick={() => { void save(); }}>{busy ? '保存中…' : '保存设置'}</button><p role="status">{message}</p>
  </section>;
}

function CollabPage({ source, rpc, openSession }: { source: Source; rpc: Rpc; openSession(id: string): void }) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [workflowSupported, setWorkflowSupported] = useState<boolean>();
  const workflowProbe = useRef<Promise<boolean>>();
  const [view, setView] = useState('all'), [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [selected, setSelected] = useState(''), [creating, setCreating] = useState(false), [nonce, setNonce] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<CollabInboxItem>(), [explorationStatus, setExplorationStatus] = useState<'active' | 'history'>('active');
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
    if (view === 'participating' && workflowSupported !== true) { setCatalog({ tasks: [], peers: [], hasMore: false }); setLoading(false); return; }
    let active = true; setLoading(true); setError('');
    const load = view === 'inbox' ? rpc('inbox', { offset }).then(v => { if (active) setInbox(v); }) : rpc('catalog', { view, query, offset, ...(view === 'participating' ? { explorationStatus } : {}) }).then(async v => {
      if (!active) return;
      setCatalog(v);
      if (workflowSupported === undefined && v.tasks.length) {
        workflowProbe.current ??= rpc<CollabDetail>('detail', { taskId: v.tasks[0].id }).then(supportsWorkflow).catch(error => { workflowProbe.current = undefined; throw error; });
        const supported = await workflowProbe.current;
        if (active) setWorkflowSupported(supported);
      }
    });
    void load.catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rpc, view, query, offset, selected, creating, nonce, state?.cursor, explorationStatus, workflowSupported]);
  const openTask = (id: string, event?: CollabInboxItem) => { setSelectedEvent(event); setSelected(id); };
  const chooseView = (next: string) => { if (next === 'participating' && workflowSupported !== true) return; setView(next); setOffset(0); setSelected(''); setSelectedEvent(undefined); setCreating(false); };
  return <CollabVoiceProvider rpc={rpc}><main className="collab" data-testid="collab-page"><header className="collab-header"><div><h1>协作空间</h1><p>{state ? `${state.peer.nickname} · ${state.peer.id.slice(0, 6)}` : '正在加载本机身份…'}</p></div><div className="collab-actions">{state?.lastSyncAt && <small>消息更新于 {new Date(state.lastSyncAt).toLocaleTimeString()}</small>}<button disabled={refreshing} onClick={() => { void refresh(); }}>{refreshing ? '刷新中…' : '刷新消息'}</button><button className="collab-primary" onClick={() => { setCreating(true); openTask(''); }}>发布任务</button></div></header>
    <nav className="collab-tabs" aria-label="协作空间视图">{[['all', '任务广场'], ['mine', '我发布的'], ['following', '我关注的'], ['participating', '我参与的'], ['inbox', `消息${state?.unread ? ` (${state.unread})` : ''}`], ['settings', '设置']].map(([key, label]) => <button key={key} aria-selected={view === key && !creating} disabled={key === 'participating' && workflowSupported !== true} title={key === 'participating' && workflowSupported !== true ? workflowSupported === false ? '中继待升级，暂不支持参与筛选' : '正在确认中继能力' : undefined} onClick={() => chooseView(key)}>{label}</button>)}</nav>
    <div className="collab-content">{syncError && <p className="collab-banner" role="alert">{syncError}</p>}
      {!state ? <p>正在加载…</p> : creating ? <NewTask rpc={rpc} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); openTask(id); }} /> : selected ? <TaskDetail key={selected + ':' + (selectedEvent?.id ?? '')} taskId={selected} initialEvent={selectedEvent} rpc={rpc} state={state} openSession={openSession} onBack={() => openTask('')} onWorkflowSupport={setWorkflowSupported} /> : view === 'settings' ? <Settings state={state} rpc={rpc} /> : <>
        <div className="collab-row">{view !== 'inbox' ? <div className="collab-search"><CollabInput label="搜索任务" placeholder="搜索任务标题、内容或标签" maxLength={120} value={query} onChange={value => { setQuery(value); setOffset(0); }} /></div> : <h2>消息</h2>}{view === 'inbox' && <button onClick={() => { void rpc('read', { through: state.cursor }).then(() => { setNonce(n => n + 1); void source.refresh(); }).catch(e => setError(e.message)); }}>全部标记已读</button>}</div>
        {view === 'participating' && workflowSupported === true && <div className="collab-actions collab-attempt-filter"><button aria-pressed={explorationStatus === 'active'} onClick={() => { setExplorationStatus('active'); setOffset(0); }}>进行中 / 待处理</button><button aria-pressed={explorationStatus === 'history'} onClick={() => { setExplorationStatus('history'); setOffset(0); }}>已结束</button><small>这里只列出已启动 AI 参与的任务；普通回复和关注不会加入。</small></div>}
        {error && <p role="alert" className="collab-error">{errorText[error] ?? error}</p>}{loading && <p role="status" className="collab-muted">正在同步…</p>}
        {view === 'inbox' ? <div className="collab-list">{inbox.items.map(item => <button className={'collab-card collab-task ' + (item.read ? '' : 'unread')} key={item.id} data-event-id={item.id} onClick={() => openTask(item.taskId, item)}><strong>{item.title}</strong><span>{eventText[item.kind] ?? '任务有更新'}</span><small>节点 {item.actorId.slice(0, 6)} · {date(item.at)} · {item.read ? '已读' : '未读'}</small></button>)}{!loading && !inbox.items.length && <p className="collab-empty">暂无消息。发布、回复或关注任务后，更新会显示在这里。</p>}</div> : <div className="collab-list">{catalog.tasks.map(task => <button className="collab-card collab-task" key={task.id} onClick={() => openTask(task.id)}><div className="collab-row"><span className={'collab-status ' + task.status}>{statusText[task.status]}</span><small>{date(task.updatedAt)}</small></div><h2>{task.title}</h2><p>{task.description.slice(0, 180)}</p><div className="collab-row"><span>{who(catalog.peers, task.authorId)}</span><small>{task.replyCount} 条回复 · {task.solutionCount} 个方案{task.following ? ' · 已关注' : ''}</small></div></button>)}{!loading && !catalog.tasks.length && <p className="collab-empty">暂无匹配任务。可以发布问题，也可以调整筛选。</p>}</div>}
        <div className="collab-pagination"><button disabled={offset === 0 || loading} onClick={() => setOffset(n => Math.max(0, n - 50))}>上一页</button><span>第 {Math.floor(offset / 50) + 1} 页</span><button disabled={loading || !(view === 'inbox' ? inbox.hasMore : catalog.hasMore)} onClick={() => setOffset(n => n + 50)}>下一页</button></div>
      </>}
    </div>
  </main></CollabVoiceProvider>;
}
function CollabIcon({ size = 18 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="6" cy="6" r="3" /><circle cx="18" cy="7" r="3" /><circle cx="12" cy="18" r="3" /><path d="m9 6 6 1M7 9l4 6m6-5-4 5" /></svg>; }

function RegisteredCollabPage(props: Parameters<typeof CollabPage>[0]) {
  const state = useSyncExternalStore(props.source.subscribe, props.source.getSnapshot);
  const scopedRpc: Rpc = useMemo(() => (method, args = {}, signal) => props.rpc(method, { ...args, $relayProfileId: state?.relayProfileId ?? '' }, signal), [props.rpc, state?.relayProfileId]);
  return <><details className="collab-relay-picker"><summary>中继：{state?.relayProfileName ?? '配置管理'}</summary><CollabRelaySettings rpc={props.rpc} changed={props.source.refresh} /></details>
    {state?.registered ? <CollabPage key={state.relayProfileId ?? 'legacy'} {...props} rpc={scopedRpc} /> : <main className="collab" data-testid="collab-registration-required"><h1>协作空间</h1><p role="status">{state ? '请展开上方中继配置，选择或注册中继。' : '正在读取中继配置…'}</p></main>}</>;
}

export function apply(ctx: Context) {
  const abort = new AbortController();
  let snapshot: CollabState | null = null, pending = false, stateRevision = 0;
  const listeners = new Set<() => void>();
  const rpc: Rpc = async (method, args = {}, signal) => {
    const result = await ctx.connection.rpc.call(method.startsWith('speech/') ? '/api' : '/desktop-collab', method, { args }, signal ? AbortSignal.any([abort.signal, signal]) : abort.signal);
    if (!result.ok) throw new Error(errorText[result.error.message] ?? result.error.message);
    if (method === 'profile' && !abort.signal.aborted) { stateRevision++; snapshot = result.value; for (const fn of listeners) fn(); }
    if (['relays/switch', 'relays/adopt'].includes(method) && !abort.signal.aborted) { stateRevision++; snapshot = null; for (const fn of listeners) fn(); }
    return result.value;
  };
  const source: Source = { subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSnapshot: () => snapshot,
    async refresh() { if (pending || abort.signal.aborted) return; pending = true; const revision = stateRevision; try { const value = await rpc<CollabState>('state'); if (!abort.signal.aborted && revision === stateRevision) { snapshot = value; for (const fn of listeners) fn(); } } catch {} finally { pending = false; } } };
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = __DSH_COLLAB_CSS__; document.head.append(style);
    const unsubscribe = window.dshDesktop?.onRemoteState(() => { void source.refresh(); });
    void initializeRelayProfiles(rpc).then(() => source.refresh()).catch(() => source.refresh());
    const timer = setInterval(() => { void source.refresh(); }, 1500);
    return () => { abort.abort(); unsubscribe?.(); clearInterval(timer); listeners.clear(); style.remove(); };
  }, 'collab: state and styles');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'p2p-collab', inject: () => ({ source, rpc, openSession: (id: string) => ctx.uiWorkspace.openSession(id) }) }, RegisteredCollabPage));
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-p2p-collab', priority: -10, inject: () => ({ rpc, changed: source.refresh }) }, CollabRelaySettings));
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'p2p-collab', order: 12, label: () => '协作空间' }, CollabIcon)), 'collab: workspace entry');
}
