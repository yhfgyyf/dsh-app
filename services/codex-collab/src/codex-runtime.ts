import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { mkdir, realpath, writeFile, readFile, lstat } from 'node:fs/promises';
import { AppServer, type AppServerOptions } from './app-server.ts';
import { readJson, writeJson } from './storage.ts';
import { imageMetadata, imageLimits, type ImageReference } from './image.ts';
import type { CollabSessionInspection, DeriveTurnUsage } from '../../../src/runtime/collab-usage.ts';

type Usage = NonNullable<ReturnType<DeriveTurnUsage>>;
export type ManagedSession = { id: string; threadId: string; cwd: string; title: string; model?: string; provider?: string; createdAt: number; updatedAt: number;
  parentSession?: string; status: 'idle' | 'running'; activeTurn?: string; loadedGeneration?: number; events: any[]; items: any[]; totalUsage?: any; turnBase?: any; usageEvent?: number;
  wireEvents?: any[]; wireTurn?: number; requests?: Record<string, { digest: string; turnId?: string; pending: boolean }>;
  uploads?: Record<string, { path: string; name: string; bytes: number; sha256: string; consumedBy?: string }>;
  images?: Record<string, { path: string; attachment: ImageReference }>; error?: string; effort?: string };
export type PendingInput = { id: string; sessionId: string; turnId: string; method: string; params: any; nativeId: string | number; generation: number };
export type RuntimeOptions = AppServerOptions & { model?: string };

function usageDelta(current: any, base: any): Usage | undefined {
  const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
  if (!keys.every(k => Number.isSafeInteger(current?.[k]) && current[k] >= 0)) return;
  const delta: any = {};
  for (const key of [...keys, 'cacheWriteInputTokens']) {
    delta[key] = (current[key] ?? 0) - (base?.[key] ?? 0);
    if (!Number.isSafeInteger(delta[key]) || delta[key] < 0) return;
  }
  const uncached = delta.inputTokens - delta.cachedInputTokens - delta.cacheWriteInputTokens;
  if (uncached < 0 || delta.reasoningOutputTokens > delta.outputTokens || delta.inputTokens + delta.outputTokens !== delta.totalTokens) return;
  return { uncachedInputTokens: uncached, outputTokens: delta.outputTokens, totalTokens: delta.totalTokens,
    cacheReadTokens: delta.cachedInputTokens, cacheWriteTokens: delta.cacheWriteInputTokens, reasoningTokens: delta.reasoningOutputTokens };
}

/** Usage is one measured Codex turn aggregate, updated in place, never counted per streamed chunk. */
export const deriveCodexUsage: DeriveTurnUsage = events => {
  const values: Usage[] = events.filter(e => e.type === 'assistant/message' || e.type === 'assistant/attempt').map(e => e.data.usage);
  if (!values.length || values.some(v => !v)) return;
  const total = { uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  for (const value of values) for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += value[key] ?? 0;
  return total;
};

export class CodexRuntime extends EventEmitter {
  readonly app: AppServer;
  readonly home: string;
  readonly sessions = new Map<string, ManagedSession>();
  readonly pending = new Map<string, PendingInput>();
  private options: RuntimeOptions;
  private writing: Promise<unknown> = Promise.resolve();
  private mutations = new Map<string, Promise<unknown>>();
  private early = new Map<string, { at: number; bytes: number; frames: { method: string; params: any }[] }>();
  constructor(home: string, options: RuntimeOptions = {}) {
    super(); this.home = home; this.options = options; this.app = new AppServer(options);
    this.app.on('notification', frame => this.notification(frame.method, frame.params));
    this.app.on('request', frame => this.requested(frame));
    this.app.on('disconnected', () => {
      this.pending.clear(); this.early.clear();
      for (const session of this.sessions.values()) if (session.status === 'running') this.end(session, session.activeTurn!, 'interrupted');
      this.emit('changed'); void this.flush().catch(() => {});
    });
  }
  async restore() {
    const config = await readJson<{ model?: string }>(join(this.home, 'codex-config.json'), {});
    if (config.model !== undefined) this.modelName(config.model);
    this.options.model ??= config.model;
    const data = await readJson<{ version: number; sessions: ManagedSession[] }>(join(this.home, 'sessions.json'), { version: 1, sessions: [] });
    if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('Unsupported Codex session file.');
    for (const session of data.sessions) {
      if (!session.id || !session.threadId || !Array.isArray(session.events) || !Array.isArray(session.items)) throw new Error('Invalid Codex session file.');
      session.loadedGeneration = undefined; this.sessions.set(session.id, session);
      if (session.status === 'running') this.end(session, session.activeTurn!, 'interrupted');
    }
  }
  flush() {
    const snapshot = { version: 1, sessions: [...this.sessions.values()].map(({ loadedGeneration: _, ...s }) => structuredClone(s)) };
    const writing = this.writing.then(() => writeJson(join(this.home, 'sessions.json'), snapshot));
    this.writing = writing.catch(() => {}); return writing;
  }
  list = async () => [...this.sessions.values()].map(s => ({ header: { id: s.id, ...(s.parentSession ? { parentSession: s.parentSession, origin: 'subagent' } : {}) } }));
  inspect = async (id: string): Promise<CollabSessionInspection> => {
    const s = this.session(id); return { meta: { id: s.id, parentSession: s.parentSession, origin: s.parentSession ? 'subagent' : undefined }, inheritedEventCount: 0, events: structuredClone(s.events) };
  };
  get = (id: string) => {
    const s = this.sessions.get(id); if (!s) return;
    return { status: s.status, cancel: () => { void this.cancel({ sessionId: id }).catch(() => {}); } };
  };
  session(id: string) { const s = this.sessions.get(id); if (!s) throw new Error('Managed Codex session not found.'); return s; }
  get defaultModel() { return this.options.model ?? null; }
  private modelName(model: unknown): string {
    if (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/.test(model)) throw new Error('Invalid Codex model name.'); return model;
  }
  async configureModel(model: string | null) {
    const name = model === null ? undefined : this.modelName(model);
    await writeJson(join(this.home, 'codex-config.json'), { ...(name ? { model: name } : {}) }); this.options.model = name;
    return { model: name ?? null, appliesTo: 'new-sessions' };
  }
  async models() { await this.app.start(); return this.app.request('model/list', {}); }
  selectModel = async ({ sessionId, model, reasoningEffort }: { sessionId: string; model: string; reasoningEffort?: string }) => this.exclusive(sessionId, async () => {
    const s = this.session(sessionId); if (s.status === 'running') throw new Error('Wait for the running turn before selecting a model.');
    if (reasoningEffort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)) throw new Error('Invalid reasoning effort.');
    s.model = this.modelName(model); s.effort = reasoningEffort; await this.flush(); this.emit('changed');
    return { selected: { provider: 'codex', model: s.model, ...(s.effort ? { reasoningEffort: s.effort } : {}) } };
  });
  private exclusive<T>(id: string, action: () => Promise<T>) {
    const task = (this.mutations.get(id) ?? Promise.resolve()).then(action);
    this.mutations.set(id, task.catch(() => {})); return task;
  }
  private async directory(cwd: string) {
    const root = resolve(this.home, 'collaboration', 'workspaces'), candidate = resolve(cwd);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Workspace root cannot be a symlink.');
    const actualRoot = await realpath(root), inside = (rel: string) => !rel.startsWith('..') && !isAbsolute(rel);
    const rel = [relative(root, candidate), relative(actualRoot, candidate)].find(inside);
    if (rel === undefined) throw new Error('Session workspace must be inside this collaboration profile.');
    let actual = actualRoot;
    for (const segment of rel.split('/').filter(Boolean)) {
      actual = join(actual, segment);
      try { await mkdir(actual, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(actual);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Workspace symlinks cannot escape this profile.');
    }
    return actual;
  }
  create = async ({ sessionId = 'session-' + randomUUID(), cwd = join(this.home, 'collaboration', 'workspaces', sessionId) }: { sessionId?: string; cwd?: string }) => this.exclusive(sessionId, async () => {
    if (this.sessions.has(sessionId)) throw new Error('Session already exists.');
    cwd = await this.directory(cwd); await this.app.start();
    const result = await this.app.request('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', ...(this.options.model ? { model: this.options.model } : {}) });
    const s: ManagedSession = { id: sessionId, threadId: result.thread.id, cwd, title: 'Codex', createdAt: Date.now(), updatedAt: Date.now(), status: 'idle', events: [], items: [],
      model: result.model, provider: result.modelProvider, loadedGeneration: this.app.generation };
    this.sessions.set(sessionId, s); await this.flush(); this.emit('changed'); return { sessionId, threadId: s.threadId };
  });
  rename = async ({ sessionId, title }: { sessionId: string; title: string }) => {
    const s = this.session(sessionId); if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Invalid session title.');
    await this.ensureLoaded(s); await this.app.request('thread/name/set', { threadId: s.threadId, name: title });
    s.title = title; s.updatedAt = Date.now(); await this.flush(); this.emit('changed'); return { sessionId, title };
  };
  private async ensureLoaded(s: ManagedSession) {
    await this.app.start();
    if (s.loadedGeneration === this.app.generation) return;
    await this.app.request('thread/resume', { threadId: s.threadId, cwd: s.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    s.loadedGeneration = this.app.generation;
  }
  upload = async (sessionId: string, bytes: Buffer, suppliedName: unknown) => this.exclusive(sessionId, async () => {
    const s = this.session(sessionId);
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Uploads must be between 1 byte and 8 MiB.');
    if (Object.values(s.uploads ?? {}).reduce((n, file) => n + file.bytes, 0) + bytes.length > 256 * 1024 * 1024) throw new Error('This session has reached its upload limit.');
    const name = basename(typeof suppliedName === 'string' ? suppliedName : 'attachment').replace(/[\x00-\x1f\x7f\\]/g, '_').replace(/^\.+$/, '_').slice(0, 150) || 'attachment';
    const receiptId = randomUUID(), directory = await this.directory(join(s.cwd, '.uploads', receiptId)), path = join(directory, name);
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    s.uploads ??= {}; s.uploads[receiptId] = { path, name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await this.flush(); return { receiptId, file: { attachmentId: s.uploads[receiptId].sha256, name, bytes: bytes.length } };
  });
  async attachment(sessionId: string, attachmentId: string) {
    const s = this.session(sessionId), image = s.images?.[attachmentId];
    if (!image || !s.wireEvents?.some(e => e.type === 'user/message' && e.data.content.some((p: any) => p.type === 'image' && p.attachment.attachmentId === attachmentId))) throw new Error('Image is not referenced by this session.');
    const actual = await realpath(image.path), rel = relative(await realpath(join(this.home, 'collaboration/workspaces')), actual);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Image escaped its workspace.');
    const bytes = await readFile(actual);
    if (bytes.length !== image.attachment.bytes || createHash('sha256').update(bytes).digest('hex') !== attachmentId) throw new Error('Image integrity check failed.');
    return { attachment: image.attachment, data: bytes.toString('base64') };
  }
  prompt = async (value: any, signal?: AbortSignal) => this.exclusive(value.sessionId, async () => {
    const s = this.session(value.sessionId); await this.ensureLoaded(s);
    const content = value.content;
    if (!Array.isArray(content) || !content.length || content.length > 64) throw new Error('Expected prompt content.');
    const requestId = value.requestId ?? randomUUID();
    if (typeof requestId !== 'string' || requestId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(requestId)) throw new Error('Invalid prompt request ID.');
    const digest = createHash('sha256').update(JSON.stringify({ content, mode: value.mode ?? 'queue', cwd: value.cwd ?? null })).digest('hex');
    s.requests ??= {};
    const previous = s.requests[requestId];
    if (previous) {
      if (previous.digest !== digest) throw new Error('Request ID was already used for a different prompt.');
      if (previous.pending) throw new Error('The previous prompt outcome is uncertain. Inspect the session before sending more work.');
      return { requestId, sessionId: s.id, turnId: previous.turnId };
    }
    const input = [], receipts: string[] = []; let imageBytes = 0, imageCount = 0;
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') input.push({ type: 'text', text: part.text, text_elements: [] });
      else if (part?.type === 'image' && imageLimits.mediaTypes.includes(part.mediaType) && typeof part.data === 'string') {
        const bytes = Buffer.from(part.data, 'base64');
        if (!bytes.length || bytes.length > imageLimits.maxImageBytes || bytes.toString('base64') !== part.data) throw new Error('Invalid image bytes.');
        imageBytes += bytes.length; imageCount++;
        if (imageBytes > imageLimits.maxMessageImageBytes || imageCount > imageLimits.maxImagesPerMessage) throw new Error('Image batch exceeds this bridge limit.');
        const metadata = imageMetadata(bytes, part.mediaType), attachmentId = createHash('sha256').update(bytes).digest('hex');
        s.images ??= {};
        if (!s.images[attachmentId]) {
          if (Object.values(s.images).reduce((n, image) => n + image.attachment.bytes, 0) + bytes.length > 256 * 1024 * 1024) throw new Error('This session has reached its image limit.');
          const path = join(await this.directory(join(s.cwd, '.images')), attachmentId);
          try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(path)).equals(bytes)) throw error; }
          s.images[attachmentId] = { path, attachment: { attachmentId, ...metadata, bytes: bytes.length, ...(typeof part.name === 'string' ? { name: basename(part.name).replace(/[\x00-\x1f\x7f\\]/g, '_').slice(0, 150) } : {}) } };
        }
        input.push({ type: 'image', url: `data:${part.mediaType};base64,${part.data}` });
      } else if (part?.type === 'file') {
        const file = s.uploads?.[part.receiptId];
        if (!file || file.consumedBy) throw new Error('File receipt is unavailable or belongs to another session.');
        const actual = await realpath(file.path), rel = relative(await realpath(join(this.home, 'collaboration', 'workspaces')), actual);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Uploaded file escaped its workspace.');
        const bytes = await readFile(actual);
        if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Uploaded file changed before use.');
        input.push({ type: 'text', text: `User-uploaded file: ${JSON.stringify({ name: file.name, path: file.path, bytes: file.bytes, sha256: file.sha256 })}`, text_elements: [] });
        receipts.push(part.receiptId);
      } else throw new Error('Unsupported prompt content.');
    }
    if (s.status === 'running') {
      if (value.mode !== 'steer') throw new Error('This session is running. Wait, steer, or stop it first.');
      for (const id of receipts) s.uploads![id].consumedBy = requestId;
      s.requests[requestId] = { digest, pending: true }; await this.flush();
      const result = await this.app.request('turn/steer', { threadId: s.threadId, expectedTurnId: s.activeTurn, input, clientUserMessageId: requestId }, signal);
      s.requests[requestId] = { digest, pending: false, turnId: result.turnId }; await this.flush();
      return { requestId, sessionId: s.id, turnId: result.turnId };
    }
    const cwd = value.cwd ? await this.directory(value.cwd) : s.cwd;
    for (const id of receipts) s.uploads![id].consumedBy = requestId;
    s.requests[requestId] = { digest, pending: true }; await this.flush();
    const result = await this.app.request('turn/start', { threadId: s.threadId, input, cwd, model: s.model, ...(s.effort ? { effort: s.effort } : {}), clientUserMessageId: requestId }, signal);
    s.cwd = cwd; s.requests[requestId] = { digest, pending: false, turnId: result.turn.id };
    // Notifications can arrive before the response, including a fully completed short turn.
    if (!s.events.some(e => e.type === 'turn/start' && e.data.turn === result.turn.id)) this.begin(s, result.turn.id);
    await this.flush(); return { requestId, sessionId: s.id, turnId: result.turn.id };
  });
  cancel = async ({ sessionId }: { sessionId: string }) => {
    const s = this.session(sessionId);
    if (s.status === 'running' && s.activeTurn) await this.app.request('turn/interrupt', { threadId: s.threadId, turnId: s.activeTurn });
    return { sessionId };
  };
  private begin(s: ManagedSession, turn: string) {
    if (s.events.some(e => e.type === 'turn/start' && e.data.turn === turn)) return;
    s.status = 'running'; s.activeTurn = turn; s.error = undefined; s.turnBase = s.totalUsage ? { ...s.totalUsage } : undefined;
    s.events.push({ type: 'turn/start', data: { turn } }, { type: 'step/start', data: { turn, step: turn } });
    s.usageEvent = s.events.length;
    s.events.push({ type: 'assistant/attempt', data: { turn, step: turn } });
    s.wireTurn = (s.wireTurn ?? 0) + 1;
    this.wire(s, 'turn/start', { turn: s.wireTurn }); this.wire(s, 'step/start', { turn: s.wireTurn, step: s.wireTurn });
    s.updatedAt = Date.now(); this.emit('changed');
  }
  private end(s: ManagedSession, turn: string, reason: string) {
    if (s.activeTurn !== turn) return;
    const event = s.events[s.usageEvent!];
    if (event) {
      const last = s.items.findLast(i => i.turnId === turn && i.type === 'agentMessage');
      event.type = 'assistant/message'; event.data.interrupted = reason !== 'completed';
      event.data.message = { role: 'assistant', content: [{ type: 'text', text: last?.text ?? '' }], source: { provider: s.provider ?? 'codex', model: s.model ?? 'unknown' } };
    }
    s.events.push({ type: 'step/end', data: { turn, step: turn } }, { type: 'turn/end', data: { turn, reason, ...(s.error ? { error: s.error } : {}) } });
    this.wire(s, 'step/end', { turn: s.wireTurn, step: s.wireTurn }); this.wire(s, 'turn/end', { turn: s.wireTurn, reason: { kind: reason }, ...(s.error ? { error: s.error } : {}) });
    s.status = 'idle'; s.activeTurn = undefined; s.usageEvent = undefined; s.updatedAt = Date.now();
    for (const [id, request] of this.pending) if (request.sessionId === s.id && request.turnId === turn) this.pending.delete(id);
    this.emit('changed');
  }
  private notification(method: string, p: any) {
    if (!p) return;
    let s = [...this.sessions.values()].find(v => v.threadId === (p.threadId ?? p.thread?.id));
    if (!s && method === 'thread/started') {
      const parentId = p.thread?.parentThreadId ?? p.thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
      const parent = [...this.sessions.values()].find(v => v.threadId === parentId);
      if (parent) {
        s = { id: 'session-' + p.thread.id, threadId: p.thread.id, cwd: parent.cwd, title: 'Codex subagent', parentSession: parent.id, createdAt: Date.now(), updatedAt: Date.now(), status: 'idle', events: [], items: [], model: parent.model, provider: parent.provider, loadedGeneration: this.app.generation };
        this.sessions.set(s.id, s);
      }
    }
    if (!s) {
      // Native child events can precede their thread registration. Keep a bounded,
      // short-lived buffer; expose nothing until native parentage proves ownership.
      for (const [id, entry] of this.early) if (Date.now() - entry.at > 10000) this.early.delete(id);
      if (typeof p.threadId === 'string' && ['turn/started', 'turn/completed', 'item/completed', 'thread/tokenUsage/updated'].includes(method)) {
        const entry = this.early.get(p.threadId) ?? { at: Date.now(), bytes: 0, frames: [] };
        const bytes = Buffer.byteLength(JSON.stringify(p));
        if (this.early.size < 16 && entry.frames.length < 100 && entry.bytes + bytes < 512 * 1024) {
          entry.frames.push({ method, params: p }); entry.bytes += bytes; this.early.set(p.threadId, entry);
        }
      }
      return;
    }
    if (method === 'thread/started') {
      const early = this.early.get(s.threadId); this.early.delete(s.threadId);
      for (const frame of early?.frames ?? []) this.notification(frame.method, frame.params);
    }
    if ((method === 'error' && p.turnId !== s.activeTurn) || (method === 'turn/completed' && p.turn.id !== s.activeTurn)) return;
    if (method === 'turn/started') this.begin(s, p.turn.id);
    if (method === 'thread/tokenUsage/updated' && p.turnId === s.activeTurn) {
      const usage = usageDelta(p.tokenUsage?.total, s.turnBase);
      if (usage && s.usageEvent !== undefined) { s.events[s.usageEvent].data.usage = usage; s.totalUsage = p.tokenUsage.total; }
    }
    if (method === 'item/completed' && p.turnId === s.activeTurn) {
      const item = { ...p.item, turnId: p.turnId }, index = s.items.findIndex(i => i.id === item.id);
      if (index < 0) { s.items.push(item); this.wireItem(s, item); } else s.items[index] = item;
    }
    if (method === 'error' && !p.willRetry) s.error = String(p.error?.message ?? 'Codex execution failed.');
    if (method === 'turn/completed') {
      if (p.turn.error) s.error = String(p.turn.error.message ?? 'Codex execution failed.');
      this.end(s, p.turn.id, p.turn.status === 'completed' ? 'completed' : 'interrupted');
    }
    if (method === 'serverRequest/resolved') for (const [id, request] of this.pending) if (request.nativeId === p.requestId) this.pending.delete(id);
    this.emit('event', { sessionId: s.id, method, params: p });
    if (['turn/started', 'turn/completed', 'item/completed', 'thread/tokenUsage/updated'].includes(method)) void this.flush().catch(() => {});
  }
  private wire(s: ManagedSession, type: string, data: any) {
    s.wireEvents ??= [];
    const event = { type, seq: s.wireEvents.length, time: Date.now(), data };
    s.wireEvents.push(event); this.emit('wire', { sessionId: s.id, event });
  }
  private wireItem(s: ManagedSession, item: any) {
    const context = { turn: s.wireTurn, step: s.wireTurn };
    if (item.type === 'userMessage') this.wire(s, 'user/message', { id: item.id, role: 'user', source: { kind: 'user' }, content: item.content.flatMap((v: any) => {
      if (v.type === 'image' && typeof v.url === 'string' && v.url.startsWith('data:image/')) {
        const id = createHash('sha256').update(Buffer.from(v.url.slice(v.url.indexOf(',') + 1), 'base64')).digest('hex'), image = s.images?.[id];
        return image ? [{ type: 'image', attachment: image.attachment }] : [{ type: 'text', text: '[Image unavailable]' }];
      }
      if (v.type !== 'text') return [];
      const file = Object.values(s.uploads ?? {}).find(f => f.consumedBy && v.text === `User-uploaded file: ${JSON.stringify({ name: f.name, path: f.path, bytes: f.bytes, sha256: f.sha256 })}`);
      return file ? [{ type: 'file', attachment: { attachmentId: file.sha256, name: file.name, bytes: file.bytes } }] : [{ type: 'text', text: v.text }];
    }) });
    if (item.type === 'agentMessage') this.wire(s, 'assistant/message', { ...context, message: { id: item.id, role: 'assistant', source: { kind: 'model', provider: s.provider ?? 'codex', model: s.model ?? 'default' }, content: [{ type: 'text', text: item.text }] } });
    if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) {
      this.wire(s, 'tool/call', { ...context, callId: item.id, name: item.type, arguments: JSON.stringify(item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd } : item) });
      this.wire(s, 'tool/result', { ...context, message: { id: item.id + '-result', role: 'tool', source: { kind: 'tool', callId: item.id }, content: [{ type: 'text', text: item.aggregatedOutput ?? JSON.stringify(item) }] } });
    }
  }
  private requested(frame: any) {
    const s = [...this.sessions.values()].find(v => v.threadId === frame.params?.threadId);
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
    if (!s || s.activeTurn !== frame.params?.turnId || !supported.includes(frame.method)) { this.app.reject(frame.id, 'This client cannot answer this request.'); return; }
    const request: PendingInput = { id: randomUUID(), sessionId: s.id, turnId: s.activeTurn!, method: frame.method, params: frame.params, nativeId: frame.id, generation: this.app.generation };
    this.pending.set(request.id, request); this.emit('input', request); this.emit('changed');
  }
  answer(id: string, result: any) {
    const request = this.pending.get(id);
    if (!request || request.generation !== this.app.generation || this.session(request.sessionId).activeTurn !== request.turnId) throw new Error('This request has expired.');
    if (request.method.endsWith('requestUserInput')) {
      if (!result?.answers || typeof result.answers !== 'object') throw new Error('Answers are required.');
      for (const q of request.params.questions) if (!Array.isArray(result.answers[q.id]?.answers) || result.answers[q.id].answers.some((a: any) => typeof a !== 'string')) throw new Error('Each question needs text answers.');
    } else if (request.method === 'item/permissions/requestApproval') {
      if (!result?.permissions || !['turn', 'session'].includes(result.scope)) throw new Error('A scoped permission response is required.');
    } else if (request.method === 'mcpServer/elicitation/request') {
      if (!['accept', 'decline', 'cancel'].includes(result?.action)) throw new Error('Invalid elicitation response.');
    } else if (!['accept', 'decline', 'cancel'].includes(result?.decision)) throw new Error('Use accept, decline, or cancel for this request only.');
    this.app.respond(request.nativeId, result); this.pending.delete(id); this.emit('changed'); return { answered: true };
  }
  async stop() { await this.app.stop(); await this.flush(); }
}
