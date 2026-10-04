import { link, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { collabJson, type CollabBroker, type CollabGrant } from './collab-transport.ts';
import { idField, numberField, record, textField, type CollabEvent, type CollabPeer } from '../../services/relay/src/collab-types.ts';
import { DEFAULT_COLLAB_SETTINGS, type CollabLocalAttempt, type CollabRecoveryState, type CollabRun, type CollabSettings, type CollabState } from '../shared/collab.ts';

export type CollabLocalData = { version: 1; peerId: string; nickname: string; cursor: number; origin?: string; createdAt: number;
  settings: CollabSettings; runs: Record<string, CollabRun>; drafts: Record<string, unknown>; attempts: Record<string, CollabLocalAttempt> };
const semanticEvents = new Set(['task.updated', 'reply.created', 'solution.submitted', 'validation.created', 'solution.accepted']);
export class CollabClient {
  data!: CollabLocalData;
  private readonly file: string;
  private writing = Promise.resolve();
  private unread = 0;
  private lastSyncAt?: number;
  private requests = new AbortController();
  private joined?: { key: string; token: string; recovery: CollabRecoveryState };
  private joining?: { key: string; token: string; signal: AbortSignal; promise: Promise<void> };
  private recovery: CollabRecoveryState = { supported: null, ready: false };
  private recoverySecret?: string;
  private loadingRecovery?: Promise<string>;
  private stopped = true;
  private syncing?: Promise<void>;
  private syncAgain = false;
  readonly home: string;
  private readonly broker: CollabBroker;
  constructor(home: string, broker: CollabBroker) { this.home = home; this.broker = broker; this.file = join(home, 'collaboration', 'profile.json'); }
  async restore() {
    await mkdir(join(this.home, 'collaboration'), { recursive: true, mode: 0o700 });
    try {
      const source = await readFile(this.file, 'utf8');
      if (source.length > 32 * 1024 * 1024) throw new Error('协作本地记录过大，原文件已保留。');
      const value = record(JSON.parse(source));
      if (value.version !== 1) throw new Error('不支持此协作配置版本。');
      idField(value.peerId); textField(value.nickname, 48); numberField(value.cursor);
      record(value.runs); record(value.drafts); record(value.settings);
      this.data = value as CollabLocalData;
      this.data.settings.publishMode ??= 'review';
      this.data.settings.executionMode ??= 'manual';
      this.data.attempts ??= {};
      record(this.data.attempts);
      for (const attempt of Object.values(this.data.attempts)) if (attempt.publicUpdate && attempt.publicUpdate.payload.direction !== (attempt.publicDirection ?? '')) {
        // A legacy pending operation may already have reached the relay. Never reuse its ID with changed content.
        const operationId = randomUUID();
        attempt.publicUpdate = { operationId, payload: { ...attempt.publicUpdate.payload, operationId, direction: attempt.publicDirection ?? '' } };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const adjectives = ['青竹', '远山', '晴空', '星河', '晨风', '银杏'];
      const animals = ['鲸鱼', '海豚', '白鹭', '云雀', '松鼠', '水獭'];
      const id = randomUUID();
      this.data = { version: 1, peerId: id, nickname: adjectives[parseInt(id.slice(0, 2), 16) % adjectives.length] + animals[parseInt(id.slice(2, 4), 16) % animals.length],
        cursor: 0, createdAt: Date.now(), settings: { ...DEFAULT_COLLAB_SETTINGS }, runs: {}, drafts: {}, attempts: {} };
      await this.save();
    }
  }
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const write = this.writing.then(async () => {
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, snapshot, { mode: 0o600 }); await rename(temporary, this.file);
    });
    this.writing = write.catch(() => {}); return write;
  }
  state(): CollabState {
    return { peer: { id: this.data.peerId, nickname: this.data.nickname, createdAt: this.data.createdAt }, registered: this.broker.isRegistered(), syncing: !!this.syncing,
      origin: this.data.origin, recovery: { ...this.recovery }, unread: this.unread, cursor: this.data.cursor, lastSyncAt: this.lastSyncAt, settings: { ...this.data.settings },
      attempts: Object.values(this.data.attempts).sort((a, b) => b.updatedAt - a.updatedAt).map(attempt => structuredClone(attempt)),
      runs: Object.values(this.data.runs).sort((a, b) => b.startedAt - a.startedAt).slice(0, 200).map(({ output: _output, report: _report, submission: _submission, inputContributionDigests: _digests, publication, ...run }) => ({ ...run, ...(publication ? { publication: { ...publication, payload: undefined } } : {}) })) };
  }
  async identity(signal?: AbortSignal) {
    const requestSignal = signal ? AbortSignal.any([signal, this.requests.signal]) : this.requests.signal;
    requestSignal.throwIfAborted();
    const local = { localPeerId: this.data.peerId, localNickname: this.data.nickname, origin: this.data.origin, recovery: { ...this.recovery } };
    let grant: CollabGrant;
    try { grant = await this.broker.grant(); }
    catch { requestSignal.throwIfAborted(); return { ...local, remoteError: { code: 'identity_grant_failed' } }; }
    requestSignal.throwIfAborted();
    if (this.data.origin && grant.origin !== this.data.origin) throw new Error('已切换中继；请先导出原协作身份，再明确重置协作配置。');
    const diagnostic = { ...local, origin: grant.origin, recovery: this.joined?.key === this.registrationKey(grant) ? { ...this.joined.recovery } : { supported: null, ready: false } };
    try {
      // Diagnosis must work even when join would conflict, and must never repair or persist identity implicitly.
      const value = await collabJson(grant.origin + '/collab/v1/me', grant.token, undefined, grant.ca, requestSignal);
      const peer = record(record(value).peer);
      return { ...diagnostic, serverPeer: { id: idField(peer.id), nickname: textField(peer.nickname, 48), createdAt: numberField(peer.createdAt) } };
    } catch (error) {
      requestSignal.throwIfAborted();
      const remote = error as { code?: unknown; status?: unknown };
      const code = typeof remote?.code === 'string' && ['peer_not_joined', 'identity_conflict', 'peer_suspended'].includes(remote.code) ? remote.code : 'identity_lookup_failed';
      const status = typeof remote?.status === 'number' && Number.isInteger(remote.status) && remote.status >= 100 && remote.status <= 599 ? remote.status : undefined;
      return { ...diagnostic, remoteError: { code, ...(status === undefined ? {} : { status }) } };
    }
  }
  async api(path: string, body?: unknown, signal?: AbortSignal) {
    const requestSignal = signal ? AbortSignal.any([signal, this.requests.signal]) : this.requests.signal;
    requestSignal.throwIfAborted();
    const grant = await this.broker.grant();
    requestSignal.throwIfAborted();
    if (this.data.origin && grant.origin !== this.data.origin) throw new Error('已切换中继；请先导出原协作身份，再明确重置协作配置。');
    await this.ensureIdentity(grant, requestSignal);
    requestSignal.throwIfAborted();
    const value = await this.withGrant(grant, path, body, requestSignal);
    // A confirmed write must not become a failure because the subsequent inbox refresh failed.
    if (body !== undefined && path !== 'me' && path !== 'attachments') void this.sync().catch(() => {});
    return value;
  }
  private withGrant(grant: CollabGrant, path: string, body?: unknown, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_/?=&%.-]+$/.test(path) || path.includes('..') || path.startsWith('/')) throw new Error('无效的协作操作。');
    return collabJson(grant.origin + '/collab/v1/' + path, grant.token, body, grant.ca, signal);
  }
  start() { if (!this.stopped) return; this.stopped = false; this.requests = new AbortController(); this.joined = undefined; this.recovery = { supported: null, ready: false }; }
  async stop() {
    this.stopped = true; this.requests.abort();
    await this.syncing?.catch(() => {}); await this.joining?.promise.catch(() => {}); await this.loadingRecovery?.catch(() => {}); await this.writing;
  }
  private registrationKey(grant: CollabGrant) { return JSON.stringify([grant.origin, grant.deviceId ?? grant.token]); }
  private async loadRecoverySecret(): Promise<string> {
    if (this.recoverySecret) return this.recoverySecret;
    if (this.loadingRecovery) return this.loadingRecovery;
    const loading = (async () => {
      const folder = join(this.home, 'collaboration'), file = join(folder, 'recovery.json');
      const syncDirectory = async () => {
        // Windows does not support opening directories with these portable Node file APIs.
        if (process.platform === 'win32') return;
        const directory = await open(folder, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      };
      const read = async () => {
        if ((await lstat(file)).isSymbolicLink()) throw new Error('协作恢复凭据无效，原文件已保留。');
        const handle = await open(file, process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 4096) throw new Error('协作恢复凭据无效，原文件已保留。');
          let value: Record<string, unknown>;
          try { value = record(JSON.parse(await handle.readFile('utf8'))); }
          catch { throw new Error('协作恢复凭据无效，原文件已保留。'); }
          const secret = value.recoverySecret;
          if (value.version !== 1 || value.peerId !== this.data.peerId || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, 'base64url').toString('base64url') !== secret) throw new Error('协作恢复凭据无效，原文件已保留。');
          if (process.platform !== 'win32') { if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600); await handle.sync(); }
          // Also sync a concurrently published key before trusting its directory entry.
          await syncDirectory(); return secret;
        } finally { await handle.close(); }
      };
      try { return await read(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const secret = randomBytes(32).toString('base64url'), temporary = file + '.' + randomUUID() + '.tmp';
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, peerId: this.data.peerId, recoverySecret: secret })); await handle.sync(); }
        finally { await handle.close(); }
        // Publish without replacing another client's key. No request can expose a key before this succeeds.
        try { await link(temporary, file); await syncDirectory(); return secret; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return await read(); }
      } finally { await rm(temporary, { force: true }); }
    })();
    this.loadingRecovery = loading;
    try { this.recoverySecret = await loading; return this.recoverySecret; }
    finally { if (this.loadingRecovery === loading) this.loadingRecovery = undefined; }
  }
  private async ensureIdentity(grant: CollabGrant, requestSignal: AbortSignal): Promise<void> {
    const key = this.registrationKey(grant);
    while (true) {
      requestSignal.throwIfAborted();
      if (this.data.origin && grant.origin !== this.data.origin) throw new Error('已切换中继；请先导出原协作身份，再明确重置协作配置。');
      if (this.joined?.key === key && (this.joined.recovery.ready || this.joined.token === grant.token)) return;
      const signal = this.requests.signal;
      if (this.joining) {
        if (this.joining.key === key && this.joining.token === grant.token && this.joining.signal === signal) return this.joining.promise;
        // Another registration's result cannot authorize this device or poison its retry.
        await this.joining.promise.catch(() => {}); continue;
      }
      this.recovery = { supported: null, ready: false };
      const promise = (async () => {
        const recoverySecret = await this.loadRecoverySecret(); signal.throwIfAborted();
        const peer = await this.withGrant(grant, 'join', { id: this.data.peerId, nickname: this.data.nickname, recoverySecret }, signal) as CollabPeer & { recovery?: { supported?: unknown; ready?: unknown } };
        signal.throwIfAborted();
        if (peer.id !== this.data.peerId) throw new Error('协作节点身份不一致。');
        this.data.origin = grant.origin;
        if (peer.nickname !== this.data.nickname) await this.withGrant(grant, 'me', { nickname: this.data.nickname }, signal);
        await this.save(); signal.throwIfAborted();
        const supported = peer.recovery?.supported === true;
        this.recovery = { supported, ready: supported && peer.recovery?.ready === true };
        this.joined = { key, token: grant.token, recovery: { ...this.recovery } };
      })().finally(() => { if (this.joining?.promise === promise) this.joining = undefined; });
      this.joining = { key, token: grant.token, signal, promise };
      return promise;
    }
  }
  sync(): Promise<void> {
    this.syncAgain = true;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      while (this.syncAgain && !this.stopped) {
        this.syncAgain = false;
        const value = await this.api('sync?after=' + this.data.cursor);
        const cursor = numberField(value.cursor);
        const events: CollabEvent[] = (Array.isArray(value.events) ? value.events : []).map((raw: unknown) => {
          const event = record(raw);
          return { id: numberField(event.id, 1), taskId: idField(event.taskId), actorId: idField(event.actorId), kind: textField(event.kind, 80), at: numberField(event.at), subjectId: event.subjectId ? idField(event.subjectId) : null,
            sourceAttemptId: event.sourceAttemptId ? idField(event.sourceAttemptId) : null };
        });
        for (const attempt of Object.values(this.data.attempts)) {
          if (['withdrawn', 'completed'].includes(attempt.status)) continue;
          if (value.reset) {
            // A restored/replaced relay journal cannot prove what the model has reviewed.
            attempt.desiredState = 'paused'; attempt.status = 'paused';
            attempt.waitReason = '中继事件历史已重置，请核对最新任务后手动恢复。';
            attempt.syncError = attempt.waitReason;
            // Sequence numbers can be reused by the replacement journal. Keep the old
            // evidence separately so it neither suppresses nor impersonates new events.
            (attempt.eventArchive ??= []).push({ at: Date.now(), reason: attempt.waitReason, receivedCursor: attempt.receivedCursor,
              reviewedCursor: attempt.reviewedCursor, pendingEvents: attempt.pendingEvents, decisions: attempt.decisions });
            attempt.pendingEvents = []; attempt.decisions = [];
            attempt.eventEpoch = (attempt.eventEpoch ?? 0) + 1;
            attempt.receivedCursor = cursor; attempt.reviewedCursor = cursor;
            continue;
          }
          const known = new Set(attempt.pendingEvents.map(event => event.id));
          const ownReplies = new Set(attempt.runIds.flatMap(id => { const run = this.data.runs[id]; return [run?.publication?.replyId, run?.submittedReplyId].filter(Boolean); }));
          for (const event of events) {
            if (event.taskId !== attempt.taskId || event.id <= attempt.receivedCursor || event.id <= attempt.reviewedCursor || known.has(event.id) || !semanticEvents.has(event.kind)) continue;
            if (['reply.created', 'solution.submitted'].includes(event.kind) && (event.sourceAttemptId === attempt.id || (event.actorId === this.data.peerId && ownReplies.has(event.subjectId ?? '')))) continue;
            attempt.pendingEvents.push(event); known.add(event.id);
          }
          attempt.receivedCursor = Math.max(attempt.receivedCursor, cursor);
        }
        // Persist receipt and the inbox together; reading the UI never advances reviewedCursor.
        this.data.cursor = cursor; this.unread = numberField(value.unread); this.lastSyncAt = Date.now();
        await this.save();
        if (value.hasMore) this.syncAgain = true;
      }
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
}
