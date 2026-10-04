import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { MAX_ATTACHMENT_BYTES, type CollabAttachment, type CollabDetail, type CollabInboxItem, type CollabPeer, type CollabReply, type CollabTask, type ExecutionReport, type UsageCounts } from '../../services/relay/src/collab-types.ts';
import { collabSettings, MAX_COLLAB_MINUTES, type CollabRpcResult, type CollabRun, type CollabState } from '../shared/collab.ts';
import { CollabInput, CollabMarkdown, CollabVoiceProvider } from './collab-input.tsx';
import type { CollabExecutionMode, CollabGeneratedFile, CollabPublishMode, CollabLocalAttempt as LocalAttempt } from '../shared/collab.ts';

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
type Draft = { operationId: string; title: string; body: string; acceptance: string; tags: string; kind: 'message' | 'solution'; verification: string; limitations: string; attachments: CollabAttachment[]; generatedFiles?: CollabGeneratedFile[]; runId?: string; reportSnapshot?: string; replaces?: string; baseRevision?: number };
const freshDraft = (): Draft => ({ operationId: crypto.randomUUID(), title: '', body: '', acceptance: '', tags: '', kind: 'message', verification: '', limitations: '', attachments: [] });
const relayUpgradeMessage = '中继待升级：此中继暂不支持持续探索、候选索引、验证与正式验收。任务和讨论仍可使用。';
const supportsWorkflow = (detail: CollabDetail) => Number.isSafeInteger(detail.task.specRevision) && detail.task.specRevision > 0 && Array.isArray(detail.attempts) && Array.isArray(detail.validations);
const statusText: Record<string, string> = { open: '开放中', review: '开放中 · 有候选', resolved: '已验收', closed: '已关闭', completed: '探索已结束', error: '需要处理', working: '正在探索', waiting: '等待新信息', ready: '结果待发布', paused: '已暂停', budget: '预算已耗尽', submitted: '结果已提交', withdrawn: '已退出' };
const runStatusText: Record<string, string> = { preparing: '本轮准备中', running: '本轮运行中', completed: '本轮已完成', stopped: '本轮已停止', error: '本轮需要处理' };
const publishModes = [['manual', '仅保存本机', 'AI 结果保留在本机，由你选择草稿后发布。'], ['review', '填入草稿待审核', 'AI 结果填入空白草稿，你检查、修改后发布；已有草稿会保留。'], ['auto', '自动公开发布', '有实质进展或候选时公开正文和所列附件；不自动验收任务。']] as const;
const publishText = (mode?: CollabPublishMode) => publishModes.find(value => value[0] === (mode ?? 'review'))![1];
const historicalAttempt = (attempt: { status: string }) => ['withdrawn', 'completed'].includes(attempt.status);
function reveal(element: HTMLElement | null) {
  if (!element) return;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
  element.scrollIntoView({ block: 'start' }); element.focus({ preventScroll: true });
}
const eventText: Record<string, string> = { 'task.created': '发布了任务', 'task.updated': '更新了任务要求', 'reply.created': '有新贡献或讨论', 'solution.submitted': '有新候选方案', 'solution.accepted': '任务已正式验收', 'validation.created': '有新验证结果', 'participation.updated': '参与进度更新', 'attempt.updated': '探索进度更新' };
const date = (time: number) => new Date(time).toLocaleString();
const who = (peers: CollabPeer[], id: string) => `${peers.find(p => p.id === id)?.nickname ?? '协作节点'} · ${id.slice(0, 6)}`;
const errorText: Record<string, string> = { collaboration_not_configured: '中继尚未启用协作服务，请先部署协作组件。', identity_conflict: '本机协作身份与中继登记不一致。更新插件不会自动重置身份，请先诊断并核对绑定后再处理。', peer_not_joined: '协作身份尚未就绪，请重试本次操作。', author_required: '只有任务发布者可以执行此操作。', task_changed: '任务已更新，请刷新详情后重试。', task_not_open: '任务已结束，需要发布者重新开放。', requirements_need_revalidation: '任务已验收，请先重新开放，再修改要求并重新验证。', solution_replaced: '此候选已有修订版本，请刷新详情后验证最新候选。', valid_verification_required: '请先选择针对当前候选和当前要求的通过验证，再正式验收。', access_revoked: '此设备的协作访问已撤销。', operation_conflict: '该提交的内容已变化，请重新检查并发布。', storage_quota: '附件存储配额已满，请在正文中提供下载链接。', peer_suspended: '此节点已暂停访问。', attachment_too_large: '附件过大，单个文件最多 8 MiB。请在正文中提供下载链接。', payload_too_large: '上传内容过大，请改为在正文中提供下载链接。', request_too_large: '上传内容过大，请改为在正文中提供下载链接。' };
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
    <CollabInput label="验收要求" disabled={busy} rows={3} markdown maxLength={12000} placeholder="什么结果算完成，以及如何验证；暂不填写会标为尚未约定。" value={d.acceptance} onChange={value => field('acceptance', value)} />
    <details className="collab-optional"><summary>补充信息（可选）</summary>
      <CollabInput label="标题" disabled={busy} maxLength={200} value={d.title} onChange={value => field('title', value)} />
      <CollabInput label="标签" disabled={busy} maxLength={200} placeholder="用逗号分隔，如 Python、调试" value={d.tags} onChange={value => field('tags', value)} />
    </details>
    <Upload files={d.attachments} onChange={attachments => draft.setValue(v => ({ ...v, attachments }))} rpc={rpc} onError={setError} disabled={busy} onBusyChange={setUploading} />
    {(error || draft.error) && <p role="alert" className="collab-error">{error || draft.error}</p>}
    <div className="collab-row"><small>草稿保存在本机；支持 Markdown、代码和链接。</small><button className="collab-primary" disabled={busy || uploading || !draft.ready || !d.body.trim()} onClick={() => { void submit(); }}>{busy ? '发布中…' : '发布任务'}</button></div>
  </section>;
}
function MyParticipation({ attempt, rpc, ended, occupied, supported, onChanged }: { attempt: LocalAttempt; rpc: Rpc; ended: boolean; occupied: boolean; supported: boolean; onChanged(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [nextStep, setNextStep] = useState(attempt.nextStep ?? '');
  const [addingBudget, setAddingBudget] = useState(false), [tokens, setTokens] = useState('0'), [minutes, setMinutes] = useState('0');
  const active = attempt.desiredState === 'active', withdrawn = attempt.desiredState === 'withdrawn';
  useEffect(() => { setNextStep(attempt.nextStep ?? ''); }, [attempt.nextStep]);
  const act = async (method: string) => {
    if (!supported && method === 'attempt-resume') { setError(relayUpgradeMessage); return; }
    setBusy(true); setError('');
    try {
      const args: Record<string, unknown> = { attemptId: attempt.id };
      if (method === 'attempt-resume') {
        args.nextStep = nextStep;
        if (addingBudget || attempt.status === 'budget') {
          const extraTokens = Number(tokens), extraMinutes = Number(minutes);
          if (!tokens.trim() || !minutes.trim() || !Number.isSafeInteger(extraTokens) || extraTokens < 0 || !Number.isSafeInteger(extraMinutes) || extraMinutes < 0 || extraMinutes > MAX_COLLAB_MINUTES) throw new Error('追加预算须为非负整数。');
          if (attempt.status === 'budget' && !extraTokens && !extraMinutes) throw new Error('预算已耗尽，请明确填写追加额度后恢复。');
          args.additionalTokens = extraTokens; args.additionalMinutes = extraMinutes;
        }
      }
      await rpc(method, args); setAddingBudget(false); setTokens('0'); setMinutes('0'); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  };
  return <article className="collab-attempt" data-attempt-id={attempt.id} tabIndex={-1}>
    <div className="collab-row"><strong>{attempt.direction || '本机探索'}</strong><span className={'collab-status ' + attempt.status}>{statusText[attempt.status] ?? attempt.status}</span></div>
    <p className="collab-muted">{attempt.executionMode === 'continuous' ? '持续探索' : '单次探索'} · {publishText(attempt.publishMode)} · 基于要求版本 {attempt.baseRevision} · {attempt.runIds.length} 轮运行</p>
    <p className="collab-muted">公开方向：{attempt.publicDirection || '尚未公开方向'}</p>
    {attempt.baseRevision !== attempt.currentTaskRevision && <p className="collab-banner">任务要求已更新至版本 {attempt.currentTaskRevision}，继续探索时需要重新核对。</p>}
    <p><strong>下一步：</strong>{attempt.nextStep || '尚未确定'}</p>
    {attempt.waitReason && <p><strong>等待原因：</strong>{attempt.waitReason}</p>}
    <p className="collab-muted">待评估更新 {(attempt.pendingEvents ?? []).length} 条 · 已结算至少 {(attempt.usedTokens ?? 0).toLocaleString()} Token / {attempt.limits.maxTokens ? attempt.limits.maxTokens.toLocaleString() : '不限'} · 已计入运行 {Math.ceil((attempt.usedMillis ?? 0) / 60000)} / {attempt.limits.maxMinutes || '不限'} 分钟</p>
    {attempt.status === 'paused' && <p className="collab-banner">已暂停。新消息会保留在待评估更新中，只有你恢复后才会继续。</p>}
    {attempt.status === 'budget' && <p className="collab-banner">整个探索的累计预算已耗尽，追加额度后才能恢复。</p>}
    {attempt.syncError && <p role="alert" className="collab-error">公开进度同步失败：{attempt.syncError}。本机探索记录已保留。</p>}
    {!supported && <p className="collab-banner">中继待升级：此探索保留在本机，仍可暂停或退出；继续探索及公开状态同步需要升级中继。</p>}
    {!!attempt.eventArchive?.length && <details className="collab-optional"><summary>中继历史重置前的 {attempt.eventArchive.reduce((count, item) => count + item.pendingEvents.length, 0)} 条待评估信息已保留</summary>{attempt.eventArchive.map((item, index) => <div key={index}><p>{date(item.at)} · {item.reason}</p>{item.pendingEvents.map(event => <p key={event.id}>{eventText[event.kind] ?? '任务更新'} · {date(event.at)}</p>)}{item.decisions.map((decision, i) => <p key={i}>此前评估：{decision.reason || decision.decision}</p>)}</div>)}</details>}
    {!!attempt.decisions?.length && <details className="collab-optional"><summary>最近的更新评估</summary>{attempt.decisions.slice(-5).map((decision, i) => <p key={i}>{decision.reason || decision.decision} <small>· {date(decision.at)}</small></p>)}</details>}
    {!withdrawn && !ended && <div className="collab-actions">
      {active && <button disabled={busy} onClick={() => { void act('attempt-pause'); }}>暂停探索</button>}
      <button disabled={busy} onClick={() => { void act('attempt-withdraw'); }}>退出探索</button>
    </div>}
    {!withdrawn && !ended && !['working'].includes(attempt.status) && <details className="collab-optional collab-resume"><summary>恢复或继续探索</summary>
      <CollabInput label="继续探索的下一步" value={nextStep} onChange={setNextStep} rows={2} maxLength={12000} disabled={busy} />
      <label className="collab-check"><input type="checkbox" checked={addingBudget || attempt.status === 'budget'} disabled={busy || attempt.status === 'budget'} onChange={event => setAddingBudget(event.target.checked)} />追加本次探索预算</label>
      {(addingBudget || attempt.status === 'budget') && <div className="collab-budget-inputs"><label>追加 Token<input aria-label="追加 Token" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={tokens} onChange={event => setTokens(event.target.value)} /></label><label>追加分钟<input aria-label="追加分钟" type="number" min={0} max={MAX_COLLAB_MINUTES} step={1} value={minutes} onChange={event => setMinutes(event.target.value)} /></label><small>追加到原累计上限；原本不限的项目仍为不限。</small></div>}
      <button disabled={busy || occupied || !supported} className="collab-primary" onClick={() => { void act('attempt-resume'); }}>{busy ? '处理中…' : '确认继续探索'}</button>
      {occupied && <small>本机已有运行，请等待其结束后继续。</small>}
    </details>}
    {error && <p role="alert" className="collab-error">{error}</p>}
  </article>;
}

function CandidateValidation({ reply, detail, peerId, rpc, onChanged }: { reply: CollabReply; detail: CollabDetail; peerId: string; rpc: Rpc; onChanged(): void }) {
  const [form, setForm] = useState({ operationId: crypto.randomUUID(), outcome: 'passed', method: '', environment: '', evidence: '' });
  const [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const task = detail.task, specRevision = task.specRevision ?? task.revision;
  const validations = (detail.validations ?? []).filter(value => value.replyId === reply.id);
  const replaced = !!reply.supersededBy || detail.replies.some(value => value.replaces === reply.id);
  const stale = reply.baseRevision !== specRevision;
  const passed = validations.filter(value => value.outcome === 'passed' && value.baseRevision === specRevision);
  const accepted = task.acceptedReplyId === reply.id, ended = ['closed', 'resolved'].includes(task.status);
  const outcomeText: Record<string, string> = { passed: '验证通过', failed: '验证失败', inconclusive: '结论不充分' };
  const field = (name: string, value: string) => setForm(old => ({ ...old, [name]: value, operationId: crypto.randomUUID() }));
  const act = async (accepting: boolean) => {
    if (!supportsWorkflow(detail)) { setError(relayUpgradeMessage); return; }
    setBusy(true); setError('');
    try {
      if (accepting) await rpc('accept', { taskId: task.id, operationId: crypto.randomUUID(), revision: task.revision, replyId: reply.id, validationId: selected });
      else {
        await rpc('validate', { taskId: task.id, replyId: reply.id, baseRevision: specRevision, ...form });
        setForm({ operationId: crypto.randomUUID(), outcome: 'passed', method: '', environment: '', evidence: '' });
      }
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  };
  return <div className="collab-validation" data-candidate-validation={reply.id}>
    <h3>验证记录</h3>
    {replaced && <p className="collab-banner">此候选已有修订版本，不能直接验收。</p>}
    {stale && <p className="collab-banner">候选基于旧要求版本 {reply.baseRevision}，需按当前要求版本 {specRevision} 重新复核。</p>}
    {!validations.length && <p className="collab-muted">尚无验证记录。提交者自验不代表任务已通过验收。</p>}
    {validations.map(value => <details key={value.id}><summary>{outcomeText[value.outcome]} · {value.authorId === reply.authorId ? '提交者自验' : '独立验证'} · {who(detail.peers, value.authorId)} · 要求版本 {value.baseRevision}{value.baseRevision !== specRevision ? ' · 已过期' : ''}</summary><p><strong>方法：</strong>{value.method}</p><p><strong>环境：</strong>{value.environment}</p><Text>{value.evidence}</Text></details>)}
    {!ended && !replaced && <details className="collab-optional"><summary>{reply.authorId === peerId ? '记录提交者自验' : '记录独立验证'}</summary>
      <label>验证结论<select aria-label="验证结论" value={form.outcome} onChange={event => field('outcome', event.target.value)}><option value="passed">通过</option><option value="failed">失败</option><option value="inconclusive">结论不充分</option></select></label>
      <CollabInput label="验证方法" rows={2} maxLength={8000} value={form.method} onChange={value => field('method', value)} disabled={busy} />
      <CollabInput label="验证环境" maxLength={4000} value={form.environment} onChange={value => field('environment', value)} disabled={busy} />
      <CollabInput label="验证证据" rows={3} markdown maxLength={16000} value={form.evidence} onChange={value => field('evidence', value)} disabled={busy} />
      <button disabled={busy || !form.method.trim() || !form.environment.trim() || !form.evidence.trim()} onClick={() => { void act(false); }}>发布验证记录</button>
    </details>}
    {accepted ? <p className="collab-accepted">✓ 发布者已正式验收此候选{detail.decision ? ` · 要求版本 ${detail.decision.baseRevision} · ${date(detail.decision.createdAt)}` : ''}</p> : !ended && !replaced && task.authorId === peerId && <div className="collab-accept"><label>验收依据<select aria-label="验收依据" value={passed.some(value => value.id === selected) ? selected : ''} onChange={event => setSelected(event.target.value)}><option value="">请选择当前要求下通过的验证</option>{passed.map(value => <option key={value.id} value={value.id}>{value.authorId === reply.authorId ? '提交者自验' : '独立验证'} · {who(detail.peers, value.authorId)} · {value.method}</option>)}</select></label><button disabled={busy || !passed.some(value => value.id === selected)} className="collab-primary" onClick={() => { void act(true); }}>正式验收并结束任务</button></div>}
    {error && <p role="alert" className="collab-error">{error}</p>}
  </div>;
}

function CandidateIndex({ taskId, detail, rpc, revision, onSelect }: { taskId: string; detail: CollabDetail; rpc: Rpc; revision: number; onSelect(id: string): void }) {
  const [offset, setOffset] = useState(0), [result, setResult] = useState<{ items: CollabReply[]; hasMore: boolean; total: number }>({ items: [], hasMore: false, total: 0 });
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    if (!supportsWorkflow(detail)) return;
    let active = true; setLoading(true); setError('');
    void rpc<typeof result>('candidates', { taskId, offset }).then(value => { if (active) setResult(value); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rpc, taskId, offset, revision, detail.cursor]);
  const specRevision = detail.task.specRevision ?? detail.task.revision;
  return <section id="collab-candidates" tabIndex={-1} className="collab-card collab-candidates" aria-label="候选方案索引"><h2>候选方案 <small>{result.total} 个有效候选</small></h2>
    <p className="collab-muted">提交候选不代表任务完成；由任务发布者选择验证依据后正式验收。</p>
    {loading && <p role="status">正在读取候选…</p>}{error && <p role="alert" className="collab-error">{error}</p>}
    {!loading && !result.items.length && <p className="collab-muted">尚无候选方案。</p>}
    {result.items.map(reply => {
      const validations = (detail.validations ?? []).filter(value => value.replyId === reply.id && value.baseRevision === specRevision);
      const passed = validations.some(value => value.outcome === 'passed'), failed = validations.some(value => value.outcome === 'failed');
      const verification = passed && failed ? '验证结论有分歧' : passed ? '当前要求下验证通过' : failed ? '有验证失败记录' : validations.length ? '验证结论不充分' : '尚待验证';
      return <button key={reply.id} className="collab-candidate-link" data-candidate-id={reply.id} onClick={() => onSelect(reply.id)}><strong>{reply.body.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 120) || '候选方案'}</strong><span>{who(detail.peers, reply.authorId)} · 要求版本 {reply.baseRevision} · {date(reply.createdAt)}</span><span>{reply.id === detail.task.acceptedReplyId ? '已正式验收' : reply.supersededBy ? '已有修订版本' : '当前有效候选'}{reply.baseRevision !== specRevision ? ' · 基于旧要求' : ''} · {verification}</span><small>查看方案与验证 →</small></button>;
    })}
    {(offset > 0 || result.hasMore) && <div className="collab-pagination"><button disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>上一页候选</button><span>第 {Math.floor(offset / 50) + 1} 页</span><button disabled={loading || !result.hasMore} onClick={() => setOffset(value => value + 50)}>下一页候选</button></div>}
  </section>;
}

function TaskDetail({ taskId, initialEvent, rpc, state, openSession, onBack, onWorkflowSupport }: { taskId: string; initialEvent?: CollabInboxItem; rpc: Rpc; state: CollabState; openSession(id: string): void; onBack(): void; onWorkflowSupport(supported: boolean): void }) {
  const [detail, setDetail] = useState<CollabDetail>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [run, setRun] = useState<CollabRun>(), [instruction, setInstruction] = useState(''), [publicDirection, setPublicDirection] = useState(''), [replyInstruction, setReplyInstruction] = useState('');
  const [executionMode, setExecutionMode] = useState<CollabExecutionMode>(state.settings.executionMode ?? 'manual');
  const [publishMode, setPublishMode] = useState<CollabPublishMode>(state.settings.publishMode ?? 'review'), [replyPublishMode, setReplyPublishMode] = useState<CollabPublishMode>(state.settings.publishMode ?? 'review');
  const [selectedRunId, setSelectedRunId] = useState(''), [pendingImport, setPendingImport] = useState<CollabRun>();
  const [replyOffset, setReplyOffset] = useState(0), [history, setHistory] = useState<CollabTask[]>();
  const [targetSubject, setTargetSubject] = useState(initialEvent?.subjectId ?? ''), [targetRequest, setTargetRequest] = useState(0), [locatedSubject, setLocatedSubject] = useState('');
  const [attemptView, setAttemptView] = useState<'active' | 'history'>('active'), [pendingDraft, setPendingDraft] = useState<Draft>();
  const root = useRef<HTMLDivElement>(null), openedEvent = useRef<number>(), navigated = useRef('');
  const [edit, setEdit] = useState<{ revision: number; title: string; description: string; acceptance: string; tags: string }>();
  const draft = useDraft(rpc, 'task:' + taskId), d = draft.value;
  const imported = useRef(new Set<string>());
  const importRun = (value: CollabRun) => {
    imported.current.add(value.id);
    const kind = value.mode === 'solve' && (!value.attemptId || value.checkpoint?.action === 'ready') ? 'solution' : 'message';
    draft.setValue(v => ({ ...v, kind, body: value.submission?.body ?? value.output ?? '', verification: value.submission?.verification ?? '', limitations: value.submission?.limitations ?? '', generatedFiles: value.submission?.files ?? [], runId: value.id, reportSnapshot: value.reportSnapshot, baseRevision: value.taskRevision, replaces: kind === 'solution' ? value.replacesReplyId : undefined }));
    setPendingImport(undefined);
    requestAnimationFrame(() => reveal(root.current?.querySelector('#collab-composer') ?? null));
  };
  const replaceDraft = (next: Draft) => { draft.setValue(next); setPendingDraft(undefined); requestAnimationFrame(() => reveal(root.current?.querySelector('#collab-composer') ?? null)); };
  const prepareDraft = (next: Draft) => {
    if (d.body.trim() || d.attachments.length || d.generatedFiles?.length) { setPendingDraft(next); requestAnimationFrame(() => reveal(root.current?.querySelector('#collab-composer') ?? null)); }
    else replaceDraft(next);
  };
  const selectSubject = (id: string) => { setTargetSubject(id); setTargetRequest(value => value + 1); setLocatedSubject(''); };
  useEffect(() => {
    if (draft.ready && run?.status === 'completed' && run.publishMode === 'review' && !run.submittedReplyId && run.submission && !imported.current.has(run.id) && !d.body && !d.attachments.length && d.runId !== run.id) importRun(run);
  }, [draft.ready, run, d.body, d.runId]);
  const refresh = () => setRevision(n => n + 1);
  useEffect(() => { if (run?.publication?.status === 'published') refresh(); }, [run?.publication?.replyId]);
  useEffect(() => {
    let active = true;
    void rpc<CollabDetail>('detail', { taskId, offset: replyOffset, ...(targetSubject ? { subjectId: targetSubject } : {}) }).then(value => { if (active) { setDetail(value); onWorkflowSupport(supportsWorkflow(value)); setReplyOffset(value.replyOffset ?? replyOffset); setLocatedSubject(targetSubject); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [rpc, taskId, state.cursor, revision, replyOffset, targetSubject, targetRequest, onWorkflowSupport]);
  useEffect(() => {
    if (!detail || (targetSubject && locatedSubject !== targetSubject)) return;
    if (!targetSubject && (!initialEvent || initialEvent.subjectId || openedEvent.current === initialEvent.id)) return;
    const navigation = `${targetSubject}:${targetRequest}`;
    if (navigated.current === navigation) return;
    const reply = detail.replies.find(value => value.id === targetSubject) ?? detail.replies.find(value => (detail.validations ?? []).some(validation => validation.id === targetSubject && validation.replyId === value.id));
    const attempt = (state.attempts ?? []).find(value => value.id === targetSubject);
    if (attempt && attemptView !== (historicalAttempt(attempt) ? 'history' : 'active')) { setAttemptView(historicalAttempt(attempt) ? 'history' : 'active'); return; }
    const element = reply ? root.current?.querySelector<HTMLElement>(`[data-reply-id="${reply.id}"]`) : targetSubject && (detail.attempts ?? []).some(value => value.id === targetSubject) ? root.current?.querySelector<HTMLElement>(`[data-attempt-id="${targetSubject}"], [data-public-attempt-id="${targetSubject}"]`) : root.current?.querySelector<HTMLElement>('#collab-overview');
    if (!element) return;
    root.current?.querySelectorAll<HTMLElement>('[data-highlighted]').forEach(value => delete value.dataset.highlighted);
    if (reply) element.dataset.highlighted = 'true';
    const frame = requestAnimationFrame(() => {
      navigated.current = navigation;
      reveal(element);
      if (initialEvent && openedEvent.current !== initialEvent.id && (initialEvent.subjectId ?? '') === targetSubject) {
        openedEvent.current = initialEvent.id;
        if (supportsWorkflow(detail)) void rpc('read', { eventIds: [initialEvent.id] }).catch(e => { openedEvent.current = undefined; setError(`标记消息已读失败：${e.message}`); });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [detail, locatedSubject, targetSubject, targetRequest, initialEvent, rpc, attemptView]);
  const taskRuns = state.runs.filter(r => r.taskId === taskId).sort((a, b) => b.startedAt - a.startedAt);
  const occupiedRun = state.runs.find(r => ['running', 'preparing'].includes(r.status));
  const activeRun = taskRuns.find(r => ['running', 'preparing'].includes(r.status));
  const attempts = (state.attempts ?? []).filter(value => value.taskId === taskId).sort((a, b) => b.startedAt - a.startedAt);
  const currentRunId = selectedRunId || activeRun?.id || d.runId || taskRuns[0]?.id;
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
    if (d.replaces && !supportsWorkflow(detail)) throw new Error('中继待升级：此草稿修订已有候选，暂不能提交；原草稿已保留。');
    await draft.save();
    await rpc('reply', { operationId: d.operationId, taskId, kind: d.kind, body: d.body, baseRevision: d.baseRevision ?? detail.task.specRevision ?? detail.task.revision, attachments: d.attachments.map(a => a.id), generatedFiles: d.generatedFiles?.map(file => file.id) ?? [], ...(d.replaces ? { replaces: d.replaces } : {}),
      ...(d.runId ? { runId: d.runId, reportSnapshot: d.reportSnapshot } : {}),
      ...(d.kind === 'solution' ? { solution: { verification: d.verification, limitations: d.limitations } } : {}) });
    await draft.clear(); setTargetSubject(''); setReplyOffset(Math.floor(detail.task.replyCount / 50) * 50);
  });
  const start = (mode: 'reply' | 'solve') => action(async () => {
    if (mode === 'solve' && (!detail || !supportsWorkflow(detail))) throw new Error(relayUpgradeMessage);
    await draft.save();
    const execution = mode === 'reply' ? 'manual' : executionMode, publishing = mode === 'reply' ? replyPublishMode : publishMode;
    collabSettings(state.settings.maxTokens, state.settings.maxMinutes, publishing, execution);
    const value = await rpc<CollabRun>('start', { operationId: crypto.randomUUID(), taskId, mode, instruction: mode === 'reply' ? replyInstruction : instruction, ...(mode === 'solve' ? { publicDirection } : {}), executionMode: execution, publishMode: publishing }); setSelectedRunId(value.id); setRun(value);
  });
  if (!detail) return <div className="collab-card"><button onClick={onBack}>返回列表</button><p role={error ? 'alert' : 'status'}>{error || '正在读取任务详情…'}</p></div>;
  const t = detail.task, specRevision = t.specRevision ?? t.revision, ended = ['resolved', 'closed'].includes(t.status), workflowSupported = supportsWorkflow(detail);
  const invalidBudget = executionMode === 'continuous' && !state.settings.maxTokens && !state.settings.maxMinutes;
  return <div ref={root} className="collab-detail" data-collab-detail={taskId}>
    <div className="collab-row"><button onClick={onBack}>← 返回列表</button><button onClick={refresh}>刷新详情</button></div>
    {!workflowSupported && <p className="collab-banner" role="status">{relayUpgradeMessage}</p>}
    {!workflowSupported && initialEvent && !initialEvent.read && <p className="collab-banner">此中继暂不支持逐条已读；本条消息保留未读，可返回消息列表显式全部标记已读。</p>}
    <nav className="collab-section-nav" aria-label="任务分区">{[['overview', '任务概览'], ['candidates', '候选方案'], ['discussion', '讨论'], ['explorations', '我的探索']].map(([id, label]) => <button key={id} onClick={() => reveal(root.current?.querySelector(`#collab-${id}`) ?? null)}>{label}</button>)}</nav>
    <section id="collab-overview" tabIndex={-1} className="collab-card collab-contract" aria-label="任务要求"><div className="collab-row"><span className={'collab-status ' + t.status}>{statusText[t.status]} · {t.solutionCount} 个候选</span><small>要求版本 {specRevision} · {date(t.createdAt)}</small></div>
      <h1>{t.title}</h1><p className="collab-muted">发布与验收：{who(detail.peers, t.authorId)}</p><div className="collab-tags">{t.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
      <strong>任务目标</strong><Text>{t.description}</Text><div className="collab-acceptance"><strong>验收要求</strong><Text>{t.acceptance || '尚未约定'}</Text></div>
      <Files files={detail.attachments} rpc={rpc} onError={setError} />
      <div className="collab-actions"><button disabled={busy} onClick={() => { void action(() => rpc('follow', { taskId, following: !t.following })); }}>{t.following ? '取消关注' : '关注任务'}</button>
        {t.authorId === state.peer.id && <button disabled={busy} onClick={() => { void action(() => rpc('update', { taskId, operationId: crypto.randomUUID(), revision: t.revision, status: ['closed', 'resolved'].includes(t.status) ? 'open' : 'closed' })); }}>{['closed', 'resolved'].includes(t.status) ? '重新开放' : '关闭任务'}</button>}
        {t.authorId === state.peer.id && <button disabled={busy} onClick={() => setEdit({ revision: t.revision, title: t.title, description: t.description, acceptance: t.acceptance, tags: t.tags.join(', ') })}>编辑任务</button>}
        <button onClick={() => { if (history) setHistory(undefined); else void action(async () => setHistory((await rpc('history', { taskId })).revisions)); }}>修改记录</button>
      </div>
    </section>
    {edit && <section className="collab-card collab-compose" aria-label="编辑任务"><h2>编辑任务 · 版本 {edit.revision}</h2>
      <CollabInput label="标题" maxLength={200} value={edit.title} onChange={title => setEdit({ ...edit, title })} />
      <CollabInput label="问题详情" rows={6} markdown maxLength={49152} value={edit.description} onChange={description => setEdit({ ...edit, description })} />
      <CollabInput label="验收要求" rows={3} markdown maxLength={12000} value={edit.acceptance} onChange={acceptance => setEdit({ ...edit, acceptance })} />
      <CollabInput label="标签" maxLength={200} value={edit.tags} onChange={tags => setEdit({ ...edit, tags })} />
      <div className="collab-actions"><button onClick={() => setEdit(undefined)}>取消</button><button disabled={busy} onClick={() => { void action(async () => { await rpc('update', { taskId, operationId: crypto.randomUUID(), ...edit, tags: edit.tags.split(/[,，]/).map(v => v.trim()).filter(Boolean) }); setEdit(undefined); setHistory(undefined); }); }}>保存新版本</button></div>
    </section>}
    {history && <section className="collab-card"><h2>最近 20 个版本</h2>{history.map(item => <details key={item.revision}><summary>要求版本 {item.specRevision ?? item.revision} · {date(item.updatedAt)} · {item.title}</summary><Text>{item.description}</Text><Text>{item.acceptance || '验收要求尚未约定'}</Text></details>)}</section>}
    {workflowSupported ? <CandidateIndex taskId={taskId} detail={detail} rpc={rpc} revision={revision} onSelect={selectSubject} /> : <section id="collab-candidates" tabIndex={-1} className="collab-card"><h2>候选方案</h2><p className="collab-muted">中继待升级：暂不支持候选索引，可在下方讨论中查看已有方案。</p></section>}
    <section id="collab-explorations" tabIndex={-1} className="collab-card" aria-label="我的探索"><div className="collab-row"><h2>我的探索</h2><small>关注只接收更新；留言不会启动探索。</small></div>
      {attempts.length > 0 && <div className="collab-actions collab-attempt-filter"><button aria-pressed={attemptView === 'active'} onClick={() => setAttemptView('active')}>进行中 / 待处理 ({attempts.filter(value => !historicalAttempt(value)).length})</button><button aria-pressed={attemptView === 'history'} onClick={() => setAttemptView('history')}>已结束 ({attempts.filter(historicalAttempt).length})</button></div>}
      {attempts.filter(value => historicalAttempt(value) === (attemptView === 'history')).map(attempt => <MyParticipation key={attempt.id} attempt={attempt} rpc={rpc} ended={ended} occupied={!!occupiedRun} supported={workflowSupported} onChanged={() => { setSelectedRunId(''); refresh(); }} />)}
      {attempts.length > 0 && !attempts.some(value => historicalAttempt(value) === (attemptView === 'history')) && <p className="collab-muted">{attemptView === 'active' ? '当前没有进行中或待处理的探索。' : '尚无已结束的探索。'}</p>}
      {!attempts.length && <p className="collab-muted">{workflowSupported ? '尚未开始本机探索。你可以先交流信息，也可以选择一个方向独立尝试。' : '中继待升级：暂不能启动本机探索。你仍可交流信息或起草一次回复。'}</p>}
      <div className="collab-actions"><button disabled={!draft.ready || busy} onClick={() => prepareDraft({ ...freshDraft(), body: '进展：\n\n已验证：\n\n下一步：', baseRevision: specRevision })}>分享进展</button><button disabled={!draft.ready || busy} onClick={() => prepareDraft({ ...freshDraft(), body: '遇到的阻塞：\n\n已尝试：\n\n需要补充：', baseRevision: specRevision })}>分享阻塞</button><small>填入公开讨论草稿，检查后再发送。</small></div>
      {!ended && <div className="collab-start"><h3>启动新的本机探索</h3><label>本次推进方式<select aria-label="本次推进方式" value={executionMode} onChange={event => setExecutionMode(event.target.value as CollabExecutionMode)} disabled={busy || !workflowSupported}><option value="manual">手动推进，每次运行一轮</option><option value="continuous">在预算内持续探索</option></select></label>
        <label>本次探索发布方式<select aria-label="本次探索发布方式" value={publishMode} onChange={event => setPublishMode(event.target.value as CollabPublishMode)} disabled={busy || !workflowSupported}>{publishModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <p className="collab-muted">整个探索累计预算：{state.settings.maxTokens ? `${state.settings.maxTokens.toLocaleString()} Token` : 'Token 不限'} · {state.settings.maxMinutes ? `${state.settings.maxMinutes} 分钟` : '时间不限'}。{executionMode === 'continuous' ? '可根据新信息继续，也可等待；用户暂停后不会自动恢复。' : '每轮结束后由你决定是否继续。'}</p>
        <p className="collab-muted">{publishModes.find(value => value[0] === publishMode)![2]} 已有探索保留各自启动时的设置。</p>
        <CollabInput label="公开探索方向（可选）" rows={2} maxLength={4000} placeholder="例如：核对缓存统计；这段内容对协作空间成员可见。" value={publicDirection} onChange={setPublicDirection} disabled={busy || !!occupiedRun || !workflowSupported} />
        <CollabInput label="本机补充要求（不公开）" rows={2} maxLength={12000} placeholder="仅用于指导本机 AI；公开成果仍按上方发布方式处理。" value={instruction} onChange={setInstruction} disabled={busy || !!occupiedRun || !workflowSupported} />
        <div className="collab-actions"><button className="collab-primary" disabled={busy || !!occupiedRun || invalidBudget || !workflowSupported} onClick={() => { void start('solve'); }}>开始本机探索</button></div>
        {invalidBudget && <p role="alert" className="collab-error">持续探索至少需要一项有限预算，请先在设置中填写 Token 或时间上限。</p>}
        {occupiedRun && <p role="status" className="collab-banner">{occupiedRun.taskId === taskId ? '本机正在运行此任务。' : `本机正在处理另一任务“${occupiedRun.title}”。`}新一轮探索需等待当前运行结束。<button onClick={() => openSession(occupiedRun.sessionId)}>查看占用会话 ↗</button></p>}
      </div>}
    </section>
    {(detail.attempts ?? []).filter(value => value.peerId !== state.peer.id).length > 0 && <section className="collab-card"><h2>其他参与者的探索</h2>{(detail.attempts ?? []).filter(value => value.peerId !== state.peer.id).map(value => <details key={value.id} data-public-attempt-id={value.id} tabIndex={-1}><summary>{who(detail.peers, value.peerId)} · {value.direction || '尚未公开方向'} · {statusText[value.status]}</summary><p>下一步：{value.nextStep || '尚未公开'}</p><p>等待原因：{value.waitReason || '尚未公开'}</p><small>要求版本 {value.baseRevision} · {date(value.updatedAt)}</small></details>)}</section>}
    {taskRuns.length > 0 && <details className="collab-card collab-run-history" aria-label="本机探索历史"><summary>本机运行历史 · {taskRuns.length} 轮</summary>{taskRuns.map((item, index) => <div className="collab-history-row" key={item.id} data-run-id={item.id}><button aria-pressed={currentRunId === item.id} onClick={() => { setSelectedRunId(item.id); setPendingImport(undefined); }}>第 {taskRuns.length - index} 轮 · {runStatusText[item.status]} · {date(item.startedAt)}</button><small>要求版本 {item.taskRevision}{item.attemptId ? ` · 探索 ${item.attemptId.slice(0, 6)}` : ' · 一次性起草'}</small><button onClick={() => openSession(item.sessionId)}>查看本机会话 ↗</button></div>)}</details>}
    {run && <section className="collab-card collab-run" data-selected-run={run.id}><div className="collab-row"><strong>所选运行 · {run.mode === 'solve' ? '探索' : '一次性起草'} · {runStatusText[run.status]}</strong><button onClick={() => openSession(run.sessionId)}>查看本机会话 ↗</button></div>
      <p className="collab-muted">本轮发布方式：{publishText(run.publishMode)}{run.attemptId ? ' · 本轮完成后，探索仍可能继续或等待更新。' : ' · 不会持续参与任务。'}</p>
      {run.checkpoint && <p>{run.checkpoint.summary}</p>}
      {run.stopReason && <p>{run.stopReason}</p>}{run.error && <p className="collab-error">{run.error}</p>}
      {run.submissionError && <p className="collab-error">{run.submissionError}，未自动发布。可检查本机会话或编辑正文后手动发布。</p>}
      {run.publicationSkipReason && <p className="collab-muted">{run.publicationSkipReason}</p>}
      {run.submittedReplyId && <p role="status">✓ 结果已由你发布；任务是否完成以正式验收为准。</p>}
      {run.publication?.status === 'published' ? <p role="status">✓ AI 已自动发布正文和附件；任务是否完成以正式验收为准。</p> : run.publication?.status === 'error' ? <><p role="alert" className="collab-error">自动发布失败：{run.publication.error}</p><button disabled={busy} onClick={() => { void action(async () => setRun(await rpc('publish-run', { runId: run.id }))); }}>重试自动发布</button></> : null}
      {['running', 'preparing'].includes(run.status) ? !run.attemptId && <button disabled={busy} onClick={() => { void action(() => rpc('cancel', { runId: run.id })); }}>停止本轮运行</button> : run.output && !run.publication && !run.submittedReplyId && d.runId !== run.id && <button disabled={busy} onClick={() => { if (d.body.trim() || d.attachments.length || d.generatedFiles?.length) setPendingImport(run); else importRun(run); }}>选作草稿并检查附件</button>}
      {pendingImport?.id === run.id && <div className="collab-banner"><p>当前草稿已有内容。替换会使用所选运行的正文与生成附件，并保留手动添加的附件。</p><button onClick={() => importRun(pendingImport)}>替换当前草稿</button><button onClick={() => setPendingImport(undefined)}>保留当前草稿</button></div>}
    </section>}
    <section id="collab-discussion" tabIndex={-1} className="collab-thread" aria-label="贡献讨论与候选方案"><div className="collab-row"><h2>讨论与方案记录 <small>{t.replyCount} 条</small></h2><button onClick={() => reveal(root.current?.querySelector('#collab-composer') ?? null)}>写回复</button></div>
      {detail.replies.length === 0 && <p className="collab-muted">还没有回复。可以先交流信息，或在本机尝试解决。</p>}
      {detail.replies.map(reply => <article key={reply.id} data-reply-id={reply.id} tabIndex={-1} className={'collab-card collab-reply ' + (reply.kind === 'solution' ? 'solution' : '')}>
        <div className="collab-row"><strong>{who(detail.peers, reply.authorId)}</strong><small>{date(reply.createdAt)}</small></div>
        <p className="collab-muted">提交者：{who(detail.peers, reply.authorId)} · {reply.actor === 'dsh' ? '由 DSH 辅助生成' : '用户填写'} · {reply.kind === 'solution' ? '候选方案' : '贡献或讨论'}{reply.replaces ? ' · 修订版本' : ''} · 要求版本 {reply.baseRevision}{reply.attemptId ? ` · 探索 ${reply.attemptId.slice(0, 6)}` : ''}</p>
        <Text>{reply.body}</Text>
        {reply.solution && <><strong>提交者提供的自验说明</strong><Text>{reply.solution.verification}</Text>{reply.solution.limitations && <><strong>限制与未验证部分</strong><Text>{reply.solution.limitations}</Text></>}{reply.solution.report ? <Report report={reply.solution.report} /> : <p className="collab-muted">手动提交，未附带 DSH 运行用量。</p>}</>}
        <Files files={reply.attachments} rpc={rpc} onError={setError} />
        {reply.replaces && <button onClick={() => selectSubject(reply.replaces!)}>查看上一版候选</button>}{reply.supersededBy && <button onClick={() => selectSubject(reply.supersededBy!)}>查看修订后的候选</button>}
        {reply.kind === 'solution' && reply.authorId === state.peer.id && !ended && !reply.supersededBy && <button disabled={busy || !draft.ready || !workflowSupported} onClick={() => { if (workflowSupported) prepareDraft({ ...freshDraft(), kind: 'solution', body: reply.body, verification: reply.solution?.verification ?? '', limitations: reply.solution?.limitations ?? '', attachments: reply.attachments, replaces: reply.id, baseRevision: specRevision }); }}>修订这个候选</button>}
        {reply.kind === 'solution' && (workflowSupported ? <CandidateValidation reply={reply} detail={detail} peerId={state.peer.id} rpc={rpc} onChanged={refresh} /> : <p className="collab-muted">中继待升级：暂不支持验证记录、正式验收与候选修订。</p>)}
      </article>)}
      <div className="collab-pagination"><button disabled={replyOffset === 0} onClick={() => { setTargetSubject(''); setReplyOffset(n => Math.max(0, n - 50)); }}>上一页讨论</button><span>第 {Math.floor(replyOffset / 50) + 1} 页</span><button disabled={!detail.hasMore} onClick={() => { setTargetSubject(''); setReplyOffset(n => n + 50); }}>下一页讨论</button></div>
    </section>
    <section id="collab-composer" tabIndex={-1} className="collab-card collab-compose" aria-label="回复任务"><div className="collab-actions"><button aria-pressed={d.kind === 'message'} onClick={() => draft.setValue(v => ({ ...v, kind: 'message', replaces: undefined }))}>贡献或讨论</button><button aria-pressed={d.kind === 'solution'} onClick={() => draft.setValue(v => ({ ...v, kind: 'solution', baseRevision: v.baseRevision ?? specRevision }))}>提交候选方案</button></div>
      {pendingDraft && <div className="collab-banner" role="status"><p>当前草稿已有内容。替换后将使用所选方案或分享模板的正文与附件。</p><button onClick={() => replaceDraft(pendingDraft)}>替换当前草稿</button><button onClick={() => setPendingDraft(undefined)}>保留当前草稿</button></div>}
      {d.replaces && <p>此提交会保留原方案并发布修订版本。<button onClick={() => draft.setValue(v => ({ ...v, replaces: undefined }))}>改为独立方案</button></p>}
      {d.replaces && !workflowSupported && <p className="collab-banner">中继待升级：此草稿修订已有候选，暂不能提交；原草稿已保留。</p>}
      <CollabInput label={d.kind === 'solution' ? '解决方法与步骤' : '回复内容'} disabled={busy || !draft.ready} rows={6} markdown maxLength={49152} value={d.body} onChange={body => draft.setValue(v => ({ ...v, body, baseRevision: v.baseRevision ?? specRevision }))} />
      {d.baseRevision && d.baseRevision !== specRevision ? <p className="collab-banner">此草稿基于要求版本 {d.baseRevision}，当前为版本 {specRevision}。发布后仍会保留原版本归属，需要重新验证。</p> : null}
      {d.kind === 'solution' && <details className="collab-optional"><summary>验证与限制（可选，正文已包含时无需重复填写）</summary><CollabInput label="实际验证与结果" disabled={busy} rows={3} markdown maxLength={16000} value={d.verification} onChange={verification => draft.setValue(v => ({ ...v, verification }))} /><CollabInput label="限制与未验证部分" disabled={busy} rows={2} markdown maxLength={8000} value={d.limitations} onChange={limitations => draft.setValue(v => ({ ...v, limitations }))} /></details>}
      {!!d.generatedFiles?.length && <div className="collab-upload" aria-label="AI 生成附件">{d.generatedFiles.map(file => <span key={file.id}><GeneratedFile file={file} runId={d.runId!} rpc={rpc} onError={setError} /><button disabled={busy} aria-label={'移除 ' + file.name} onClick={() => draft.setValue(v => ({ ...v, generatedFiles: v.generatedFiles?.filter(f => f.id !== file.id) }))}>×</button></span>)}</div>}
      <Upload files={d.attachments} reservedCount={d.generatedFiles?.length ?? 0} onChange={attachments => draft.setValue(v => ({ ...v, attachments }))} rpc={rpc} onError={setError} disabled={busy || !draft.ready} onBusyChange={setUploading} />
      {d.runId && run?.id === d.runId && run.report && <><p className="collab-muted">本次发布将附带以下运行信息。发布前请检查正文及附件。</p><Report report={run.report} /></>}
      {d.runId && currentRunId !== d.runId && <button type="button" onClick={() => setSelectedRunId(d.runId!)}>查看这份草稿的运行来源</button>}
      {d.runId && run?.id === d.runId && run.reportSnapshot !== d.reportSnapshot && <button type="button" disabled={busy} onClick={() => draft.setValue(value => ({ ...value, reportSnapshot: run.reportSnapshot }))}>更新运行信息（保留正文和附件）</button>}
      {(error || draft.error) && <p role="alert" className="collab-error">{error || draft.error}</p>}
      <div className="collab-row"><small>{d.runId ? '来源：本机 DSH 草稿' : '来源：用户填写'} · 草稿保存在本机</small><button className="collab-primary" disabled={busy || uploading || !draft.ready || !d.body.trim() || (d.kind === 'solution' && ended) || (!!d.replaces && !workflowSupported)} onClick={() => { void submit(); }}>{busy ? '提交中…' : d.kind === 'solution' ? '发布候选' : '发送回复'}</button></div>
      <details className="collab-optional collab-draft-ai"><summary>让 AI 起草一次回复</summary>
        <p className="collab-muted">只运行一轮，不加入持续探索。已有草稿会保留；生成结果按下方方式处理。</p>
        <CollabInput label="起草补充要求（不公开）" rows={2} maxLength={12000} value={replyInstruction} onChange={setReplyInstruction} disabled={busy || !!occupiedRun} />
        <label>本次起草发布方式<select aria-label="本次起草发布方式" value={replyPublishMode} onChange={event => setReplyPublishMode(event.target.value as CollabPublishMode)} disabled={busy}>{publishModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <small>本次起草上限：{state.settings.maxTokens ? `${state.settings.maxTokens.toLocaleString()} Token` : 'Token 不限'} · {state.settings.maxMinutes ? `${state.settings.maxMinutes} 分钟` : '时间不限'}。{publishModes.find(value => value[0] === replyPublishMode)![2]}</small>
        <button disabled={busy || !draft.ready || !!occupiedRun} onClick={() => { void start('reply'); }}>AI 起草一次回复</button>
        {occupiedRun && <small>本机已有运行，请等待当前运行结束。</small>}
      </details>
    </section>
  </div>;
}

function Settings({ state, rpc }: { state: CollabState; rpc: Rpc }) {
  const [nickname, setNickname] = useState(state.peer.nickname), [maxTokens, setMaxTokens] = useState(String(state.settings.maxTokens)), [maxMinutes, setMaxMinutes] = useState(String(state.settings.maxMinutes)), [message, setMessage] = useState('');
  const [publishMode, setPublishMode] = useState<CollabPublishMode>(state.settings.publishMode ?? 'review');
  const [executionMode, setExecutionMode] = useState<CollabExecutionMode>(state.settings.executionMode ?? 'manual');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); setMessage(''); try { if (!maxTokens.trim() || !maxMinutes.trim()) throw new Error('请填写 Token 阈值和运行时间；填 0 表示不限制。'); const settings = collabSettings(Number(maxTokens), Number(maxMinutes), publishMode, executionMode); await rpc('profile', { nickname, ...settings }); setMessage('已保存'); } catch (e) { setMessage(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); } };
  return <section className="collab-card collab-compose" aria-label="协作设置"><h2>协作设置</h2><p>节点 ID：<code>{state.peer.id}</code></p><p className="collab-muted">升级和重新启用插件会保留此身份。协作内容对同一空间成员及中继管理员可见。</p>
    <fieldset className="collab-modes"><legend>探索的默认推进方式</legend>{([['manual', '手动推进', '每次运行一轮，由你决定是否继续。'], ['continuous', '在预算内持续探索', '持续参与，可根据新信息继续或等待；暂停后必须由你恢复。']] as const).map(([mode, label, description]) => <label key={mode}><input type="radio" name="collab-execution-mode" value={mode} checked={executionMode === mode} onChange={() => setExecutionMode(mode)} /><span>{label}<small>{description}</small></span></label>)}</fieldset>
    <fieldset className="collab-modes"><legend>默认发布方式</legend>{publishModes.map(([mode, label, description]) => <label key={mode}><input type="radio" name="collab-publish-mode" value={mode} checked={publishMode === mode} onChange={() => setPublishMode(mode)} /><span>{label}<small>{description}</small></span></label>)}</fieldset>
    <small>两种设置相互独立，仅用于新探索；正在进行的探索保留启动时的设置。</small>
    <CollabInput label="昵称" maxLength={48} value={nickname} onChange={setNickname} disabled={busy} />
    <label>整个探索累计 Token 上限<input aria-label="整个探索累计 Token 上限" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={maxTokens} onChange={e => setMaxTokens(e.target.value)} /></label><small>每轮消耗累加到同一探索。填 0 表示不限制。按已完成调用的用量检查；进行中的单次请求可能超出阈值。</small>
    <label>整个探索累计时间上限（分钟）<input aria-label="整个探索累计时间上限（分钟）" type="number" min={0} max={MAX_COLLAB_MINUTES} step={1} value={maxMinutes} onChange={e => setMaxMinutes(e.target.value)} /></label><small>支持多天运行，填 0 表示不限制；持续探索至少需要一项有限预算。</small>
    <p className="collab-muted">本机同时运行 1 轮探索。浏览和关注不会调用模型；持续探索会按授权评估相关更新，暂停后只保留更新。</p><button disabled={busy || !nickname.trim()} className="collab-primary" onClick={() => { void save(); }}>{busy ? '保存中…' : '保存设置'}</button><p role="status">{message}</p>
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
    <nav className="collab-tabs" aria-label="协作空间视图">{[['all', '任务广场'], ['mine', '我发布的'], ['following', '我关注的'], ['participating', '我的探索'], ['inbox', `消息${state?.unread ? ` (${state.unread})` : ''}`], ['settings', '设置']].map(([key, label]) => <button key={key} aria-selected={view === key && !creating} disabled={key === 'participating' && workflowSupported !== true} title={key === 'participating' && workflowSupported !== true ? workflowSupported === false ? '中继待升级，暂不支持探索筛选' : '正在确认中继能力' : undefined} onClick={() => chooseView(key)}>{label}</button>)}</nav>
    <div className="collab-content">{syncError && <p className="collab-banner" role="alert">{syncError}</p>}
      {!state ? <p>正在加载…</p> : creating ? <NewTask rpc={rpc} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); openTask(id); }} /> : selected ? <TaskDetail key={selected + ':' + (selectedEvent?.id ?? '')} taskId={selected} initialEvent={selectedEvent} rpc={rpc} state={state} openSession={openSession} onBack={() => openTask('')} onWorkflowSupport={setWorkflowSupported} /> : view === 'settings' ? <Settings state={state} rpc={rpc} /> : <>
        <div className="collab-row">{view !== 'inbox' ? <div className="collab-search"><CollabInput label="搜索任务" placeholder="搜索任务标题、内容或标签" maxLength={120} value={query} onChange={value => { setQuery(value); setOffset(0); }} /></div> : <h2>消息</h2>}{view === 'inbox' && <button onClick={() => { void rpc('read', { through: state.cursor }).then(() => { setNonce(n => n + 1); void source.refresh(); }).catch(e => setError(e.message)); }}>全部标记已读</button>}</div>
        {view === 'participating' && workflowSupported === true && <div className="collab-actions collab-attempt-filter"><button aria-pressed={explorationStatus === 'active'} onClick={() => { setExplorationStatus('active'); setOffset(0); }}>进行中 / 待处理</button><button aria-pressed={explorationStatus === 'history'} onClick={() => { setExplorationStatus('history'); setOffset(0); }}>已结束</button><small>这里只列出已启动探索的任务；普通留言和关注不会加入。</small></div>}
        {error && <p role="alert" className="collab-error">{errorText[error] ?? error}</p>}{loading && <p role="status" className="collab-muted">正在同步…</p>}
        {view === 'inbox' ? <div className="collab-list">{inbox.items.map(item => <button className={'collab-card collab-task ' + (item.read ? '' : 'unread')} key={item.id} data-event-id={item.id} onClick={() => openTask(item.taskId, item)}><strong>{item.title}</strong><span>{eventText[item.kind] ?? '任务有更新'}</span><small>节点 {item.actorId.slice(0, 6)} · {date(item.at)} · {item.read ? '已读' : '未读'}</small></button>)}{!loading && !inbox.items.length && <p className="collab-empty">暂无消息。发布、回复或关注任务后，更新会显示在这里。</p>}</div> : <div className="collab-list">{catalog.tasks.map(task => <button className="collab-card collab-task" key={task.id} onClick={() => openTask(task.id)}><div className="collab-row"><span className={'collab-status ' + task.status}>{statusText[task.status]}</span><small>{date(task.updatedAt)}</small></div><h2>{task.title}</h2><p>{task.description.slice(0, 180)}</p><div className="collab-row"><span>{who(catalog.peers, task.authorId)}</span><small>{task.replyCount} 条回复 · {task.solutionCount} 个候选{task.following ? ' · 已关注' : ''}</small></div></button>)}{!loading && !catalog.tasks.length && <p className="collab-empty">暂无匹配任务。可以发布问题，也可以调整筛选。</p>}</div>}
        <div className="collab-pagination"><button disabled={offset === 0 || loading} onClick={() => setOffset(n => Math.max(0, n - 50))}>上一页</button><span>第 {Math.floor(offset / 50) + 1} 页</span><button disabled={loading || !(view === 'inbox' ? inbox.hasMore : catalog.hasMore)} onClick={() => setOffset(n => n + 50)}>下一页</button></div>
      </>}
    </div>
  </main></CollabVoiceProvider>;
}
function CollabIcon({ size = 18 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="6" cy="6" r="3" /><circle cx="18" cy="7" r="3" /><circle cx="12" cy="18" r="3" /><path d="m9 6 6 1M7 9l4 6m6-5-4 5" /></svg>; }

function RegisteredCollabPage(props: Parameters<typeof CollabPage>[0]) {
  const state = useSyncExternalStore(props.source.subscribe, props.source.getSnapshot);
  return state?.registered ? <CollabPage {...props} /> : <main className="collab" data-testid="collab-registration-required"><h1>协作空间</h1><p role="status">{state ? '请在插件 → dsh-p2p-collab 详情中注册中继，再开启协作空间。' : '正在读取中继注册状态…'}</p></main>;
}

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
    const unsubscribe = window.dshDesktop?.onRemoteState(state => {
      if (snapshot && snapshot.registered !== state.registered) {
        stateRevision++; snapshot = { ...snapshot, registered: state.registered }; for (const fn of listeners) fn();
      }
    });
    void source.refresh(); const timer = setInterval(() => { void source.refresh(); }, 1500);
    return () => { abort.abort(); unsubscribe?.(); clearInterval(timer); listeners.clear(); style.remove(); };
  }, 'collab: state and styles');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'p2p-collab', inject: () => ({ source, rpc, openSession: (id: string) => ctx.uiWorkspace.openSession(id) }) }, RegisteredCollabPage));
  ctx.effect(() => {
    let dispose: (() => void) | undefined;
    const sync = () => {
      if (snapshot?.registered && !dispose) dispose = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'p2p-collab', order: 12, label: () => '协作空间' }, CollabIcon));
      else if (!snapshot?.registered && dispose) { dispose(); dispose = undefined; }
    };
    const unsubscribe = source.subscribe(sync); sync();
    return () => { unsubscribe(); dispose?.(); };
  }, 'collab: registered workspace entry');
}
