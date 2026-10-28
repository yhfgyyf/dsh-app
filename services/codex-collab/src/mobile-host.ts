import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer } from './websocket.ts';
import { CodexRuntime, type ManagedSession, type PendingInput } from './codex-runtime.ts';
import { imageLimits } from './image.ts';

type Call = (method: string, args: any, signal?: AbortSignal) => Promise<any>;
type Stream = { endpoint: string; args: any; sent: Set<string> };
type Live = { id: string; index: number; startedAfterSeq: number; turn: number; chunks: any[] };
const equal = (a: unknown, b: string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function jsonBody(req: IncomingMessage, limit = 12 * 1024 * 1024) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request is too large.'); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body));
}

/** Loopback-only DSH wire adapter, reachable by paired phones through the existing E2EE tunnel. */
export class MobileHost {
  readonly token = randomBytes(32).toString('base64url');
  readonly cookie = randomBytes(32).toString('base64url');
  readonly server;
  private wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  private runtime: CodexRuntime;
  private call: Call;
  private shutdown?: () => Promise<void>;
  private eventClients = new Map<string, { socket: any; streams: Map<string, Stream> }>();
  endpoint = '';
  launchUrl = '';
  constructor(runtime: CodexRuntime, call: Call) {
    this.runtime = runtime; this.call = call;
    this.server = createServer((req, res) => { void this.http(req, res); });
    this.server.requestTimeout = 30000; this.server.headersTimeout = 10000;
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/api/remote.mux' || !this.authorizedPhone(req)) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws: any) => this.connected(ws));
    });
    runtime.on('wire', this.wire); runtime.on('input', this.input); runtime.on('changed', this.changed); runtime.on('event', this.nativeEvent);
  }
  async start() {
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
    this.endpoint = 'http://127.0.0.1:' + (this.server.address() as any).port;
    this.launchUrl = this.endpoint + '/launch?token=' + this.token;
  }
  setShutdown(shutdown: () => Promise<void>) { this.shutdown = shutdown; }
  private authorizedPhone(req: IncomingMessage) { return equal(req.headers.cookie, 'codex-collab=' + this.cookie) && req.headers.origin === this.endpoint; }
  private async http(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', this.endpoint || 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/launch' && !req.headers.origin && equal(url.searchParams.get('token'), this.token)) {
        res.writeHead(204, { 'set-cookie': `codex-collab=${this.cookie}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' }); res.end(); return;
      }
      if (req.method !== 'POST') { jsonResponse(res, 404, { error: 'not_found' }); return; }
      if (url.pathname === '/rpc') {
        if (req.headers.origin || !equal(req.headers.authorization, 'Bearer ' + this.token)) { jsonResponse(res, 403, { error: 'forbidden' }); return; }
        const b = await jsonBody(req);
        if (b.method === 'service/stop' && this.shutdown) {
          jsonResponse(res, 200, { ok: true, value: { stopping: true } });
          setImmediate(() => { void this.shutdown!(); }); return;
        }
        const value = await this.call(b.method, b.args ?? {});
        jsonResponse(res, 200, { ok: true, value }); return;
      }
      if (!this.authorizedPhone(req)) { jsonResponse(res, 403, { error: 'forbidden' }); return; }
      if (url.pathname === '/api/session/uploadFileBinary') {
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 8 * 1024 * 1024) throw new Error('Upload exceeds 8 MiB.'); chunks.push(Buffer.from(chunk)); }
        const value = await this.runtime.upload(url.searchParams.get('sessionId') ?? '', Buffer.concat(chunks), url.searchParams.get('name'));
        jsonResponse(res, 200, { ok: true, value }); return;
      }
      const b = await jsonBody(req), method = url.pathname.startsWith('/desktop-collab/') ? 'collab/' + url.pathname.slice(16) : url.pathname.startsWith('/api/') ? url.pathname.slice(5) : '';
      if (b.method !== undefined && b.method !== method.replace(/^collab\//, '')) throw new Error('Mismatched method.');
      const args = b.payload?.args ?? b.args ?? {};
      let result: any;
      try { result = { ok: true, value: method.startsWith('collab/') ? await this.call(method, args) : await this.unary(method, args) }; }
      catch (error) { result = { ok: false, error: { code: 'codex/operation_failed', message: error instanceof Error ? error.message : 'Operation failed.', details: {} } }; }
      jsonResponse(res, 200, { type: 'server-response', rpcId: b.rpcId ?? '', result });
    } catch (error) { if (!res.headersSent) jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Invalid request.' }); }
  }
  private projections(s: ManagedSession) {
    return { asOfSeq: (s.wireEvents?.length ?? 0) - 1, values: { title: s.title, sessionListMetadata: { blank: s.events.length === 0 },
      imageLimits, modelSelection: { selected: { provider: 'codex', model: s.model ?? 'default', ...(s.effort ? { reasoningEffort: s.effort } : {}) }, lastUsed: { provider: 'codex', model: s.model ?? 'default' } } } };
  }
  summary(s: ManagedSession) { return { sessionId: s.id, updatedAt: s.updatedAt, running: s.status === 'running', blank: s.events.length === 0, cwd: s.cwd, agentPreset: 'codex', parentSessionId: s.parentSession, projections: this.projections(s) }; }
  private address(args: any) {
    const address = args.address ?? args.request?.address;
    const id = address?.sessionId ?? address?.childSessionId ?? args.sessionId;
    const s = this.runtime.session(id);
    if (address?.kind === 'subagent' && s.parentSession !== address.parentSessionId) throw new Error('Subagent does not belong to this session.');
    return s;
  }
  private page(s: ManagedSession, end: number, maxMessages: unknown) {
    const events = s.wireEvents ?? [], limit = Math.min(200, Math.max(1, Number.isInteger(maxMessages) ? Number(maxMessages) : 40));
    let start = end + 1, messages = 0, bytes = 0;
    while (start > 0) {
      const event = events[start - 1], size = Buffer.byteLength(JSON.stringify(event));
      if (start <= end && (bytes + size > 4 * 1024 * 1024 || (['assistant/message', 'user/message'].includes(event.type) && messages >= limit))) break;
      start--; bytes += size; if (['assistant/message', 'user/message'].includes(event.type)) messages++;
    }
    return { records: events.slice(start, end + 1).map(event => ({ type: 'event', event })), hasMore: start > 0 };
  }
  private snapshot(s: ManagedSession, args: any) {
    const cursor = (s.wireEvents?.length ?? 0) - 1, live = this.live.get(s.id);
    return { type: 'snapshot', header: { id: s.id, cwd: s.cwd, version: 2 }, cursor, ...this.page(s, cursor, args.maxMessages), projections: this.projections(s),
      ...(args.assistantStream ? { assistantStream: { revision: this.revisions.get(s.id) ?? 0, ...(live ? { activeAttempt: { attemptId: live.id, nextIndex: live.index, startedAfterSeq: live.startedAfterSeq, turn: live.turn, step: live.turn, stream: live.chunks } } : {}) } } : {}) };
  }
  async unary(method: string, args: any): Promise<any> {
    const value = args.request ?? args;
    if (method === 'session/list') return { items: [...this.runtime.sessions.values()].filter(s => !s.parentSession).map(s => this.summary(s)) };
    if (method === 'session/search') {
      const q = String(value.query ?? '').toLowerCase();
      return { items: [...this.runtime.sessions.values()].filter(s => s.title.toLowerCase().includes(q) || JSON.stringify(s.items).toLowerCase().includes(q)).map(s => ({ sessionId: s.id, snippet: s.title })), hasMore: false };
    }
    if (method === 'session/create') { if (value.cwd || value.workspaceId) throw new Error('Codex phone sessions use an isolated collaboration workspace.'); return this.runtime.create({ sessionId: value.sessionId }); }
    if (method === 'session/prompt') { await this.runtime.prompt(value); return { accepted: true }; }
    if (method === 'session/attachment') return this.runtime.attachment(value.sessionId, value.attachmentId);
    if (method === 'session/cancel') { await this.runtime.cancel(value); return { accepted: true }; }
    if (method === 'session/rename') { const r = await this.runtime.rename(value); return { title: r.title, seq: (this.runtime.session(value.sessionId).wireEvents?.length ?? 0) - 1 }; }
    if (method === 'session/selectModel') {
      if (value.provider !== 'codex') throw new Error('Select a model from the Codex provider.');
      return this.runtime.selectModel(value);
    }
    if (method === 'session/page') {
      const s = this.address(value), max = Math.min(value.throughSeq, (value.beforeSeq ?? Infinity) - 1);
      if (!Number.isInteger(max) || max < -1 || max >= (s.wireEvents?.length ?? 0)) throw new Error('Invalid history cursor.');
      return this.page(s, max, value.maxMessages);
    }
    if (method === 'session/canOpenWorkspacePath') return false;
    if (method === 'session/modelCatalog') {
      const models = await this.runtime.models();
      return { default: { provider: 'codex', model: models.data.find((m: any) => m.isDefault)?.model ?? models.data[0]?.model ?? 'default' }, routableProviders: ['codex'], groups: [{ id: 'codex', name: 'Codex', models: models.data.map((m: any) => ({ id: m.model ?? m.id, name: m.displayName ?? m.id, description: m.description })) }], failures: [] };
    }
    if (method === 'agentPresets/list') return { presets: [{ id: 'codex', name: 'Codex', description: 'Managed Codex session' }], defaultPreset: 'codex' };
    if (method === 'skills/list') return { skills: [] };
    if (method === 'subagents/list') return { items: [...this.runtime.sessions.values()].filter(s => s.parentSession === value.parentSessionId).map(s => this.summary(s)) };
    if (method === '$events/result') return this.answerEvent(value);
    if (method === 'pluginInventory/list') return { plugins: [], capabilities: { harness: 'codex', collaboration: true, phoneControl: true } };
    throw new Error(`Codex bridge does not support ${method}.`);
  }
  private send(socket: any, value: unknown) {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(1013, 'slow_client'); return; }
    socket.send(JSON.stringify(value));
  }
  private connected(socket: any) {
    const clientId = randomUUID(), streams = new Map<string, Stream>(); this.eventClients.set(clientId, { socket, streams });
    socket.on('close', () => this.eventClients.delete(clientId)); socket.on('error', () => {});
    socket.on('message', (raw: Buffer) => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
        if (typeof m.streamId !== 'string' || m.streamId.length > 128) throw new Error('Invalid stream.');
        if (m.type === 'cancel') { streams.delete(m.streamId); this.send(socket, { type: 'end', streamId: m.streamId }); return; }
        if (m.type !== 'open' || streams.has(m.streamId) || streams.size >= 32) throw new Error('Invalid stream.');
        const rawArgs = m.payload?.args ?? {}, stream: Stream = { endpoint: m.endpoint, args: rawArgs.request ?? rawArgs, sent: new Set() };
        streams.set(m.streamId, stream);
        const item = (value: unknown) => this.send(socket, { type: 'item', streamId: m.streamId, value });
        if (m.endpoint === '$events') {
          item({ type: 'ready', clientId, host: { home: this.runtime.home, harness: 'codex', capabilities: { collaboration: true, phoneControl: true } } });
          for (const request of this.runtime.pending.values()) this.deliverInput(socket, m.streamId, stream, request);
        } else if (m.endpoint === 'session/follow') item(this.snapshot(this.address(stream.args), stream.args));
        else if (m.endpoint === 'session/control') item({ type: 'baseline', value: { queues: {}, jobs: {}, projections: Object.fromEntries([...this.runtime.sessions.values()].map(s => [s.id, this.projections(s)])) } });
        else if (m.endpoint === 'workspace/follow') item({ type: 'baseline', workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] });
        else { streams.delete(m.streamId); throw new Error(`Codex bridge does not support ${m.endpoint}.`); }
      } catch (error) { streams.delete(m?.streamId); this.send(socket, { type: 'error', streamId: m?.streamId ?? '', error: { code: 'codex/unsupported', message: error instanceof Error ? error.message : 'Invalid stream.', details: {} } }); }
    });
  }
  private wire = ({ sessionId, event }: any) => {
    for (const { socket, streams } of this.eventClients.values()) for (const [streamId, stream] of streams) {
      if (stream.endpoint === 'session/follow') {
        try { if (this.address(stream.args).id === sessionId) this.send(socket, { type: 'item', streamId, value: { type: 'event', event } }); } catch {}
      }
    }
  };
  private deliverInput(socket: any, streamId: string, stream: Stream, request: PendingInput) {
    if (stream.sent.has(request.id)) return;
    const question = request.method.endsWith('requestUserInput');
    const event = question ? 'user-questions/request' : 'approval/request';
    const subscriptions = stream.args.events;
    if (Array.isArray(subscriptions) && !subscriptions.some((s: any) => s === event || (s?.name === event && s.mode === 'waterfall') || (s?.event === event && s.mode === 'waterfall'))) return;
    stream.sent.add(request.id);
    this.send(socket, { type: 'item', streamId, value: { type: 'waterfall', event, eventId: request.id, agentId: request.sessionId,
      request: question ? { questions: request.params.questions } : { toolName: request.method, callId: request.params.itemId, reason: request.params.reason ?? request.params.command ?? JSON.stringify(request.params) } } });
  }
  private input = (request: PendingInput) => {
    for (const { socket, streams } of this.eventClients.values()) for (const [streamId, stream] of streams) if (stream.endpoint === '$events') this.deliverInput(socket, streamId, stream, request);
  };
  private changed = () => {
    for (const { socket, streams } of this.eventClients.values()) for (const [streamId, stream] of streams) {
      if (stream.endpoint !== '$events') continue;
      for (const id of stream.sent) if (!this.runtime.pending.has(id)) { this.send(socket, { type: 'item', streamId, value: { type: 'cancel', eventId: id } }); stream.sent.delete(id); }
      for (const s of this.runtime.sessions.values()) {
        this.send(socket, { type: 'item', streamId, value: { type: 'emit', event: 'api-session/added', args: [this.summary(s)] } });
        this.send(socket, { type: 'item', streamId, value: { type: 'emit', event: 'api-session/status', args: [s.id, s.status === 'running'] } });
      }
    }
  };
  private live = new Map<string, Live>();
  private revisions = new Map<string, number>();
  private nativeEvent = ({ sessionId, method, params }: any) => {
    if (!['item/agentMessage/delta', 'item/completed', 'turn/completed'].includes(method)) return;
    const s = this.runtime.session(sessionId); let live = this.live.get(sessionId); const frames: any[] = [];
    const next = () => { const revision = (this.revisions.get(sessionId) ?? 0) + 1; this.revisions.set(sessionId, revision); return revision; };
    if (method === 'item/agentMessage/delta') {
      if (params.turnId !== s.activeTurn || typeof params.delta !== 'string') return;
      if (!live || live.id !== params.itemId) {
        if (live) frames.push({ type: 'end', attemptId: live.id, revision: next(), index: live.index, outcome: { kind: 'abandoned' } });
        live = { id: params.itemId, index: 0, startedAfterSeq: (s.wireEvents?.length ?? 0) - 1, turn: s.wireTurn ?? 1, chunks: [] }; this.live.set(sessionId, live);
        frames.push({ type: 'start', attemptId: live.id, revision: next(), startedAfterSeq: live.startedAfterSeq, turn: live.turn, step: live.turn });
      }
      const time = Date.now(), chunk = { type: 'text-delta', index: 0, text: params.delta };
      live.chunks.push({ type: 'chunk', time, chunk });
      frames.push({ type: 'chunk', attemptId: live.id, revision: next(), index: live.index++, time, chunk });
    } else if (live && ((method === 'item/completed' && params.item.id === live.id) || method === 'turn/completed')) {
      const itemId = live.id, settlement = s.wireEvents?.findLast(e => e.type === 'assistant/message' && e.data.message.id === itemId);
      frames.push({ type: 'end', attemptId: live.id, revision: next(), index: live.index, outcome: settlement ? { kind: 'committed', eventType: 'assistant/message', seq: settlement.seq } : { kind: 'abandoned' } });
      this.live.delete(sessionId);
    }
    for (const { socket, streams } of this.eventClients.values()) for (const [streamId, stream] of streams) if (stream.endpoint === 'session/follow' && this.address(stream.args).id === sessionId && stream.args.assistantStream) {
      for (const frame of frames) this.send(socket, { type: 'item', streamId, value: { type: 'assistant-stream', frame } });
    }
  };
  private answerEvent(value: any) {
    const client = this.eventClients.get(value.clientId), request = this.runtime.pending.get(value.eventId);
    if (!client || !request || ![...client.streams.values()].some(s => s.sent.has(value.eventId))) throw new Error('This phone request has expired.');
    const outcome = value.outcome;
    if (outcome?.kind === 'next') return {};
    const answer = outcome?.kind === 'result' ? outcome.value : 'rejected';
    if (request.method.endsWith('requestUserInput')) {
      if (!Array.isArray(answer?.answers)) throw new Error('Questions require explicit answers.');
      return this.runtime.answer(value.eventId, { answers: Object.fromEntries(answer.answers.map((a: any) => [a.id, { answers: [...(a.selected ?? []), ...(a.custom ? [a.custom] : [])] }])) });
    }
    if (request.method === 'item/permissions/requestApproval') return this.runtime.answer(value.eventId, { permissions: answer === 'allowed-once' ? request.params.permissions : {}, scope: 'turn' });
    if (request.method === 'mcpServer/elicitation/request') return this.runtime.answer(value.eventId, { action: 'decline' });
    return this.runtime.answer(value.eventId, { decision: answer === 'allowed-once' ? 'accept' : 'decline' });
  }
  async stop() {
    this.runtime.off('wire', this.wire); this.runtime.off('input', this.input); this.runtime.off('changed', this.changed); this.runtime.off('event', this.nativeEvent);
    for (const { socket } of this.eventClients.values()) socket.terminate(); this.eventClients.clear();
    this.wss.close(); this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
