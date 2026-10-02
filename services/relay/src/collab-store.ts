import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { CollabError, attachmentIds, idField, numberField, record, reportField, tagsField, textField, MAX_ATTACHMENT_BYTES,
  type CollabAttachment, type CollabDetail, type CollabEvent, type CollabIdentity, type CollabInboxItem, type CollabPeer, type CollabReply, type CollabTask } from './collab-types.js';

type PeerRow = CollabPeer & { device: string; banned: number };
type TaskRow = Omit<CollabTask, 'tags' | 'following'> & { tags: string; following: number; hidden: number };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** One writer owns this database. Attachment bytes participate in the same durable backup. */
export class CollabStore {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collab_peers (id TEXT PRIMARY KEY, device TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, createdAt INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS collab_tasks (id TEXT PRIMARY KEY, authorId TEXT NOT NULL REFERENCES collab_peers(id), title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL, tags TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, acceptedReplyId TEXT, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS collab_task_revisions (taskId TEXT NOT NULL REFERENCES collab_tasks(id), revision INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(taskId, revision));
      CREATE TABLE IF NOT EXISTS collab_replies (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES collab_tasks(id), authorId TEXT NOT NULL REFERENCES collab_peers(id), actor TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, baseRevision INTEGER NOT NULL, replaces TEXT REFERENCES collab_replies(id), createdAt INTEGER NOT NULL, solution TEXT);
      CREATE INDEX IF NOT EXISTS collab_replies_task ON collab_replies(taskId, createdAt);
      CREATE TABLE IF NOT EXISTS collab_follows (peerId TEXT NOT NULL REFERENCES collab_peers(id), taskId TEXT NOT NULL REFERENCES collab_tasks(id), muted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(peerId, taskId));
      CREATE TABLE IF NOT EXISTS collab_participants (peerId TEXT NOT NULL REFERENCES collab_peers(id), taskId TEXT NOT NULL REFERENCES collab_tasks(id), status TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(peerId, taskId));
      CREATE TABLE IF NOT EXISTS collab_events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL REFERENCES collab_tasks(id), actorId TEXT NOT NULL REFERENCES collab_peers(id), kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collab_inbox (peerId TEXT NOT NULL REFERENCES collab_peers(id), eventId INTEGER NOT NULL REFERENCES collab_events(id), read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(peerId, eventId));
      CREATE TABLE IF NOT EXISTS collab_commands (peerId TEXT NOT NULL REFERENCES collab_peers(id), id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(peerId, id));
      CREATE TABLE IF NOT EXISTS collab_attachments (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES collab_peers(id), name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collab_attachment_links (attachmentId TEXT NOT NULL REFERENCES collab_attachments(id), taskId TEXT NOT NULL REFERENCES collab_tasks(id), replyId TEXT NOT NULL DEFAULT '', PRIMARY KEY(attachmentId, taskId, replyId));
    `);
  }
  peer(identity: CollabIdentity): CollabPeer {
    const row = this.db.prepare('SELECT * FROM collab_peers WHERE device = ?').get(identity.deviceId) as PeerRow | undefined;
    if (!row) throw new CollabError(409, 'peer_not_joined');
    if (row.banned) throw new CollabError(403, 'peer_suspended');
    return { id: row.id, nickname: row.nickname, createdAt: row.createdAt };
  }
  join(identity: CollabIdentity, value: unknown): CollabPeer {
    if (identity.kind !== 'desktop') return this.peer(identity);
    const body = record(value), id = idField(body.id);
    const nickname = textField(body.nickname, 48, true) || `青竹鲸鱼-${id.slice(0, 4)}`;
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT * FROM collab_peers WHERE device = ? OR id = ?').all(identity.deviceId, id) as PeerRow[];
      if (old.some(p => p.device !== identity.deviceId || p.id !== id)) throw new CollabError(409, 'identity_conflict');
      if (old.some(p => p.banned)) throw new CollabError(403, 'peer_suspended');
      this.db.prepare('INSERT OR IGNORE INTO collab_peers (id, device, nickname, createdAt) VALUES (?, ?, ?, ?)').run(id, identity.deviceId, nickname, Date.now());
      return this.peer(identity);
    })();
  }
  updateProfile(peer: CollabPeer, value: unknown) {
    const nickname = textField(record(value).nickname, 48);
    this.db.prepare('UPDATE collab_peers SET nickname = ? WHERE id = ?').run(nickname, peer.id);
    return { ...peer, nickname };
  }
  private task(peer: CollabPeer, id: string): CollabTask {
    const row = this.db.prepare(`SELECT t.*,
      (SELECT count(*) FROM collab_replies r WHERE r.taskId = t.id) AS replyCount,
      (SELECT count(*) FROM collab_replies r WHERE r.taskId = t.id AND r.kind = 'solution') AS solutionCount,
      EXISTS(SELECT 1 FROM collab_follows f WHERE f.taskId = t.id AND f.peerId = ?) AS following
      FROM collab_tasks t WHERE t.id = ? AND t.hidden = 0`).get(peer.id, id) as TaskRow | undefined;
    if (!row) throw new CollabError(404, 'task_not_found');
    const { hidden: _hidden, ...task } = row;
    return { ...task, tags: JSON.parse(row.tags), following: !!row.following };
  }
  cursor(): number { return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM collab_events').get() as { id: number }).id; }
  catalog(peer: CollabPeer, value: unknown) {
    const body = record(value), view = body.view ?? 'all', q = textField(body.query, 120, true), offset = numberField(body.offset ?? 0, 0, 1000000);
    if (!['all', 'mine', 'following', 'participating'].includes(view as string)) throw new CollabError(400, 'invalid_view');
    const conditions = ['t.hidden = 0'], args: (string | number)[] = [];
    if (view === 'mine') { conditions.push('t.authorId = ?'); args.push(peer.id); }
    if (view === 'following') { conditions.push('EXISTS(SELECT 1 FROM collab_follows f WHERE f.peerId = ? AND f.taskId = t.id)'); args.push(peer.id); }
    if (view === 'participating') { conditions.push('(EXISTS(SELECT 1 FROM collab_replies r WHERE r.authorId = ? AND r.taskId = t.id) OR EXISTS(SELECT 1 FROM collab_participants p WHERE p.peerId = ? AND p.taskId = t.id))'); args.push(peer.id, peer.id); }
    if (q) { conditions.push("(instr(lower(t.title), lower(?)) > 0 OR instr(lower(t.description), lower(?)) > 0 OR instr(lower(t.tags), lower(?)) > 0)"); args.push(q, q, q); }
    if (body.status) {
      if (!['open', 'review', 'resolved', 'closed'].includes(body.status as string)) throw new CollabError(400, 'invalid_status');
      conditions.push('t.status = ?'); args.push(body.status as string);
    }
    return this.db.transaction(() => {
      const ids = this.db.prepare(`SELECT t.id FROM collab_tasks t WHERE ${conditions.join(' AND ')} ORDER BY t.createdAt DESC, t.id DESC LIMIT 51 OFFSET ?`).all(...args, offset) as { id: string }[];
      const tasks = ids.slice(0, 50).map(t => this.task(peer, t.id));
      return { tasks, peers: this.peers(tasks.map(t => t.authorId)), cursor: this.cursor(), hasMore: ids.length > 50 };
    })();
  }
  private peers(ids: string[]): CollabPeer[] {
    return [...new Set(ids)].map(id => this.db.prepare('SELECT id, nickname, createdAt FROM collab_peers WHERE id = ?').get(id) as CollabPeer);
  }
  private attachments(taskId: string, replyId = ''): CollabAttachment[] {
    return this.db.prepare('SELECT a.id, a.name, a.size, a.sha256 FROM collab_attachments a JOIN collab_attachment_links l ON l.attachmentId = a.id WHERE l.taskId = ? AND l.replyId = ?').all(taskId, replyId) as CollabAttachment[];
  }
  detail(peer: CollabPeer, id: string, offset = 0): CollabDetail {
    return this.db.transaction(() => {
      const task = this.task(peer, id);
      const replies = (this.db.prepare('SELECT * FROM collab_replies WHERE taskId = ? ORDER BY createdAt, rowid LIMIT 51 OFFSET ?').all(id, offset) as (Omit<CollabReply, 'solution' | 'attachments'> & { solution: string | null })[])
        .map(r => ({ ...r, solution: r.solution ? JSON.parse(r.solution) : null, attachments: this.attachments(id, r.id) }));
      const participants = this.db.prepare('SELECT peerId, status, updatedAt FROM collab_participants WHERE taskId = ? ORDER BY updatedAt').all(id) as CollabDetail['participants'];
      return { task, replies: replies.slice(0, 50), participants, attachments: this.attachments(id), peers: this.peers([task.authorId, ...replies.map(r => r.authorId), ...participants.map(p => p.peerId)]), cursor: this.cursor(), replyOffset: offset, hasMore: replies.length > 50 };
    })();
  }
  private snapshot(peer: CollabPeer, id: string) {
    const { replyCount: _replies, solutionCount: _solutions, following: _following, ...task } = this.task(peer, id);
    this.db.prepare('INSERT OR IGNORE INTO collab_task_revisions VALUES (?, ?, ?)').run(id, task.revision, JSON.stringify(task));
  }
  history(peer: CollabPeer, id: string, offset: number) {
    this.task(peer, id);
    const rows = this.db.prepare('SELECT snapshot FROM collab_task_revisions WHERE taskId = ? ORDER BY revision DESC LIMIT 21 OFFSET ?').all(id, offset) as { snapshot: string }[];
    return { revisions: rows.slice(0, 20).map(r => JSON.parse(r.snapshot)), hasMore: rows.length > 20 };
  }
  private command<T>(peer: CollabPeer, op: unknown, name: string, value: unknown, fn: () => T): T {
    const id = idField(op), digest = hash(JSON.stringify([name, value]));
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT digest, result FROM collab_commands WHERE peerId = ? AND id = ?').get(peer.id, id) as { digest: string; result: string } | undefined;
      if (prior) {
        if (prior.digest !== digest) throw new CollabError(409, 'operation_conflict');
        return JSON.parse(prior.result) as T;
      }
      const result = fn();
      this.db.prepare('INSERT INTO collab_commands VALUES (?, ?, ?, ?, ?)').run(peer.id, id, digest, JSON.stringify(result), Date.now());
      return result;
    })();
  }
  private follow(peer: CollabPeer, taskId: string) { this.db.prepare('INSERT OR IGNORE INTO collab_follows (peerId, taskId) VALUES (?, ?)').run(peer.id, taskId); }
  private emit(peer: CollabPeer, taskId: string, kind: string) {
    const event = this.db.prepare('INSERT INTO collab_events(taskId, actorId, kind, at) VALUES (?, ?, ?, ?)').run(taskId, peer.id, kind, Date.now());
    const id = Number(event.lastInsertRowid);
    this.db.prepare('INSERT INTO collab_inbox(peerId, eventId) SELECT peerId, ? FROM collab_follows WHERE taskId = ? AND peerId != ? AND muted = 0').run(id, taskId, peer.id);
    return id;
  }
  private linkAttachments(peer: CollabPeer, ids: string[], taskId: string, replyId = '') {
    for (const id of ids) {
      const a = this.db.prepare('SELECT ownerId FROM collab_attachments WHERE id = ?').get(id) as { ownerId: string } | undefined;
      if (!a || (a.ownerId !== peer.id && !this.db.prepare('SELECT 1 FROM collab_attachment_links WHERE attachmentId = ? AND taskId = ?').get(id, taskId))) throw new CollabError(403, 'attachment_not_owned');
      this.db.prepare('INSERT OR IGNORE INTO collab_attachment_links VALUES (?, ?, ?)').run(id, taskId, replyId);
    }
  }
  createTask(peer: CollabPeer, value: unknown) {
    const b = record(value), title = textField(b.title, 200), description = textField(b.description), acceptance = textField(b.acceptance, 12000, true), tags = tagsField(b.tags), files = attachmentIds(b.attachments);
    return this.command(peer, b.operationId, 'create-task', b, () => {
      const id = randomUUID(), now = Date.now();
      this.db.prepare("INSERT INTO collab_tasks(id, authorId, title, description, acceptance, tags, status, revision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)").run(id, peer.id, title, description, acceptance, JSON.stringify(tags), now, now);
      this.linkAttachments(peer, files, id); this.follow(peer, id); this.emit(peer, id, 'task.created');
      this.snapshot(peer, id);
      return this.task(peer, id);
    });
  }
  updateTask(peer: CollabPeer, id: string, value: unknown) {
    const b = record(value), revision = numberField(b.revision, 1);
    return this.command(peer, b.operationId, 'update-task:' + id, b, () => {
      const task = this.task(peer, id);
      if (task.authorId !== peer.id) throw new CollabError(403, 'author_required');
      if (revision !== task.revision) throw new CollabError(409, 'task_changed');
      this.snapshot(peer, id);
      const title = b.title === undefined ? task.title : textField(b.title, 200), description = b.description === undefined ? task.description : textField(b.description);
      const acceptance = b.acceptance === undefined ? task.acceptance : textField(b.acceptance, 12000, true), tags = b.tags === undefined ? task.tags : tagsField(b.tags);
      const status = b.status ?? task.status;
      if (!['open', 'closed', task.status].includes(status as string)) throw new CollabError(400, 'accept_solution_to_resolve');
      this.db.prepare('UPDATE collab_tasks SET title = ?, description = ?, acceptance = ?, tags = ?, status = ?, revision = revision + 1, updatedAt = ?, acceptedReplyId = ? WHERE id = ?').run(title, description, acceptance, JSON.stringify(tags), status, Date.now(), status === 'open' ? null : task.acceptedReplyId, id);
      this.snapshot(peer, id); this.emit(peer, id, 'task.updated'); return this.task(peer, id);
    });
  }
  addReply(peer: CollabPeer, taskId: string, value: unknown) {
    const b = record(value), body = textField(b.body), files = attachmentIds(b.attachments), baseRevision = numberField(b.baseRevision, 1);
    if (!['message', 'solution'].includes(b.kind as string) || !['user', 'dsh'].includes(b.actor as string)) throw new CollabError(400, 'invalid_reply');
    const solution = b.kind === 'solution' ? record(b.solution) : undefined;
    const metadata = solution ? { verification: textField(solution.verification, 16000), limitations: textField(solution.limitations, 8000, true), report: reportField(solution.report) } : null;
    return this.command(peer, b.operationId, 'reply:' + taskId, b, () => {
      const task = this.task(peer, taskId);
      if (baseRevision > task.revision) throw new CollabError(409, 'task_changed');
      if (b.kind === 'solution' && ['closed', 'resolved'].includes(task.status)) throw new CollabError(409, 'task_not_open');
      let replaces: string | null = null;
      if (b.replaces) {
        replaces = idField(b.replaces);
        if (b.kind !== 'solution' || !this.db.prepare("SELECT 1 FROM collab_replies WHERE id = ? AND taskId = ? AND authorId = ? AND kind = 'solution'").get(replaces, taskId, peer.id)) throw new CollabError(403, 'invalid_solution_revision');
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO collab_replies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, taskId, peer.id, b.actor, b.kind, body, baseRevision, replaces, Date.now(), metadata ? JSON.stringify(metadata) : null);
      this.linkAttachments(peer, files, taskId, id); this.follow(peer, taskId);
      this.db.prepare('UPDATE collab_tasks SET updatedAt = ?, status = ? WHERE id = ?').run(Date.now(), b.kind === 'solution' ? 'review' : task.status, taskId);
      if (b.kind === 'solution') this.db.prepare("INSERT INTO collab_participants VALUES (?, ?, 'submitted', ?) ON CONFLICT(peerId, taskId) DO UPDATE SET status = 'submitted', updatedAt = excluded.updatedAt").run(peer.id, taskId, Date.now());
      this.emit(peer, taskId, b.kind === 'solution' ? 'solution.submitted' : 'reply.created');
      return { id, taskId };
    });
  }
  accept(peer: CollabPeer, taskId: string, value: unknown) {
    const b = record(value), replyId = idField(b.replyId), revision = numberField(b.revision, 1);
    return this.command(peer, b.operationId, 'accept:' + taskId, b, () => {
      const task = this.task(peer, taskId);
      if (task.authorId !== peer.id) throw new CollabError(403, 'author_required');
      if (task.revision !== revision || task.status !== 'review') throw new CollabError(409, 'task_changed');
      if (!this.db.prepare("SELECT 1 FROM collab_replies WHERE id = ? AND taskId = ? AND kind = 'solution'").get(replyId, taskId)) throw new CollabError(404, 'solution_not_found');
      this.snapshot(peer, taskId);
      this.db.prepare("UPDATE collab_tasks SET acceptedReplyId = ?, status = 'resolved', revision = revision + 1, updatedAt = ? WHERE id = ?").run(replyId, Date.now(), taskId);
      this.snapshot(peer, taskId); this.emit(peer, taskId, 'solution.accepted'); return this.task(peer, taskId);
    });
  }
  setFollow(peer: CollabPeer, taskId: string, value: unknown) {
    this.task(peer, taskId); const b = record(value);
    if (typeof b.following !== 'boolean' || (b.muted !== undefined && typeof b.muted !== 'boolean')) throw new CollabError(400, 'invalid_follow');
    if (b.following) this.db.prepare('INSERT INTO collab_follows VALUES (?, ?, ?) ON CONFLICT(peerId, taskId) DO UPDATE SET muted = excluded.muted').run(peer.id, taskId, b.muted ? 1 : 0);
    else this.db.prepare('DELETE FROM collab_follows WHERE peerId = ? AND taskId = ?').run(peer.id, taskId);
    return { following: b.following, muted: !!b.muted };
  }
  participate(peer: CollabPeer, taskId: string, value: unknown) {
    const b = record(value);
    if (!['working', 'waiting', 'withdrawn'].includes(b.status as string)) throw new CollabError(400, 'invalid_participation');
    return this.command(peer, b.operationId, 'participate:' + taskId, b, () => {
      const task = this.task(peer, taskId);
      if (task.status === 'closed' || task.status === 'resolved') throw new CollabError(409, 'task_not_open');
      this.db.prepare('INSERT INTO collab_participants VALUES (?, ?, ?, ?) ON CONFLICT(peerId, taskId) DO UPDATE SET status = excluded.status, updatedAt = excluded.updatedAt').run(peer.id, taskId, b.status, Date.now());
      this.follow(peer, taskId); this.emit(peer, taskId, 'participation.updated'); return { status: b.status };
    });
  }
  sync(peer: CollabPeer, after: number) {
    return this.db.transaction(() => {
      const cursor = this.cursor();
      const events = this.db.prepare('SELECT e.* FROM collab_events e JOIN collab_tasks t ON t.id = e.taskId WHERE e.id > ? AND t.hidden = 0 ORDER BY e.id LIMIT 201').all(after) as CollabEvent[];
      const visible = events.slice(0, 200);
      return { events: visible, cursor: events.length > 200 ? visible.at(-1)!.id : cursor, hasMore: events.length > 200, reset: after > cursor, unread: this.unread(peer) };
    })();
  }
  unread(peer: CollabPeer) { return (this.db.prepare('SELECT count(*) AS n FROM collab_inbox i JOIN collab_events e ON e.id = i.eventId JOIN collab_tasks t ON t.id = e.taskId WHERE peerId = ? AND read = 0 AND t.hidden = 0').get(peer.id) as { n: number }).n; }
  inbox(peer: CollabPeer, offset = 0) {
    const rows = this.db.prepare('SELECT e.*, i.read, t.title FROM collab_inbox i JOIN collab_events e ON e.id = i.eventId JOIN collab_tasks t ON t.id = e.taskId WHERE peerId = ? AND t.hidden = 0 ORDER BY e.id DESC LIMIT 51 OFFSET ?').all(peer.id, offset) as (CollabEvent & { read: number; title: string })[];
    return { items: rows.slice(0, 50).map(r => ({ ...r, read: !!r.read })) as CollabInboxItem[], hasMore: rows.length > 50, unread: this.unread(peer), cursor: this.cursor() };
  }
  markRead(peer: CollabPeer, value: unknown) {
    const b = record(value), through = numberField(b.through, 0);
    if (b.taskId !== undefined) {
      const taskId = idField(b.taskId); this.task(peer, taskId);
      this.db.prepare('UPDATE collab_inbox SET read = 1 WHERE peerId = ? AND eventId <= ? AND eventId IN (SELECT id FROM collab_events WHERE taskId = ?)').run(peer.id, through, taskId);
    } else this.db.prepare('UPDATE collab_inbox SET read = 1 WHERE peerId = ? AND eventId <= ?').run(peer.id, through);
    return { unread: this.unread(peer) };
  }
  upload(peer: CollabPeer, value: unknown) {
    const b = record(value), name = textField(b.name, 180), encoded = b.data;
    if (name.includes('/') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw new CollabError(400, 'invalid_attachment');
    const data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded) throw new CollabError(400, 'invalid_attachment');
    if (!data.length || data.length > MAX_ATTACHMENT_BYTES) throw new CollabError(413, 'attachment_too_large');
    return this.command(peer, b.operationId, 'upload', { name, sha256: hash(data) }, () => {
      const total = (this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM collab_attachments').get() as { n: number }).n;
      const owned = (this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM collab_attachments WHERE ownerId = ?').get(peer.id) as { n: number }).n;
      if (total + data.length > 1024 * 1024 * 1024 || owned + data.length > 256 * 1024 * 1024) throw new CollabError(413, 'storage_quota');
      const file = { id: randomUUID(), name, size: data.length, sha256: hash(data) };
      this.db.prepare('INSERT INTO collab_attachments VALUES (?, ?, ?, ?, ?, ?, ?)').run(file.id, peer.id, name, data.length, file.sha256, data, Date.now());
      return file;
    });
  }
  download(peer: CollabPeer, id: string) {
    const row = this.db.prepare('SELECT * FROM collab_attachments WHERE id = ?').get(id) as CollabAttachment & { ownerId: string; data: Buffer } | undefined;
    if (!row || (row.ownerId !== peer.id && !this.db.prepare('SELECT 1 FROM collab_attachment_links l JOIN collab_tasks t ON t.id = l.taskId WHERE l.attachmentId = ? AND t.hidden = 0').get(id))) throw new CollabError(404, 'attachment_not_found');
    return { id: row.id, name: row.name, size: row.size, sha256: row.sha256, data: row.data.toString('base64') };
  }
}
