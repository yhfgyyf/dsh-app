import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collabJson, type CollabBroker, type CollabGrant } from './collab-transport.ts';
import { idField, numberField, record, textField, type CollabPeer } from '../../services/relay/src/collab-types.ts';
import { DEFAULT_COLLAB_SETTINGS, type CollabRun, type CollabSettings, type CollabState } from '../shared/collab.ts';

export type CollabLocalData = { version: 1; peerId: string; nickname: string; cursor: number; origin?: string; createdAt: number;
  settings: CollabSettings; runs: Record<string, CollabRun>; drafts: Record<string, unknown> };
export class CollabClient {
  data!: CollabLocalData;
  private readonly file: string;
  private writing = Promise.resolve();
  private unread = 0;
  private lastSyncAt?: number;
  private requests = new AbortController();
  private joinedOrigin?: string;
  private joining?: Promise<void>;
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const adjectives = ['青竹', '远山', '晴空', '星河', '晨风', '银杏'];
      const animals = ['鲸鱼', '海豚', '白鹭', '云雀', '松鼠', '水獭'];
      const id = randomUUID();
      this.data = { version: 1, peerId: id, nickname: adjectives[parseInt(id.slice(0, 2), 16) % adjectives.length] + animals[parseInt(id.slice(2, 4), 16) % animals.length],
        cursor: 0, createdAt: Date.now(), settings: { ...DEFAULT_COLLAB_SETTINGS }, runs: {}, drafts: {} };
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
    return { peer: { id: this.data.peerId, nickname: this.data.nickname, createdAt: this.data.createdAt }, syncing: !!this.syncing,
      origin: this.data.origin, unread: this.unread, cursor: this.data.cursor, lastSyncAt: this.lastSyncAt, settings: { ...this.data.settings },
      runs: Object.values(this.data.runs).sort((a, b) => b.startedAt - a.startedAt).slice(0, 200).map(({ output: _output, report: _report, submission: _submission, publication, ...run }) => ({ ...run, ...(publication ? { publication: { ...publication, payload: undefined } } : {}) })) };
  }
  async api(path: string, body?: unknown, signal?: AbortSignal) {
    const requestSignal = signal ? AbortSignal.any([signal, this.requests.signal]) : this.requests.signal;
    requestSignal.throwIfAborted();
    const grant = await this.broker.grant();
    requestSignal.throwIfAborted();
    if (this.data.origin && grant.origin !== this.data.origin) throw new Error('已切换中继；请先导出原协作身份，再明确重置协作配置。');
    await this.ensureIdentity(grant);
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
  start() { if (!this.stopped) return; this.stopped = false; this.requests = new AbortController(); this.joinedOrigin = undefined; }
  async stop() {
    this.stopped = true; this.requests.abort();
    await this.syncing?.catch(() => {}); await this.joining?.catch(() => {}); await this.writing;
  }
  private ensureIdentity(grant: CollabGrant): Promise<void> {
    if (this.joinedOrigin === grant.origin) return Promise.resolve();
    if (this.joining) return this.joining;
    this.joining = (async () => {
      const signal = this.requests.signal;
      const peer = await this.withGrant(grant, 'join', { id: this.data.peerId, nickname: this.data.nickname }, signal) as CollabPeer;
      if (peer.id !== this.data.peerId) throw new Error('协作节点身份不一致。');
      this.data.origin = grant.origin;
      if (peer.nickname !== this.data.nickname) await this.withGrant(grant, 'me', { nickname: this.data.nickname }, signal);
      await this.save();
      signal.throwIfAborted(); this.joinedOrigin = grant.origin;
    })().finally(() => { this.joining = undefined; });
    return this.joining;
  }
  sync(): Promise<void> {
    this.syncAgain = true;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      while (this.syncAgain && !this.stopped) {
        this.syncAgain = false;
        const value = await this.api('sync?after=' + this.data.cursor);
        this.data.cursor = numberField(value.cursor); this.unread = numberField(value.unread); this.lastSyncAt = Date.now();
        await this.save();
        if (value.hasMore) this.syncAgain = true;
      }
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
}
