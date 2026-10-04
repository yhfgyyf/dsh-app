import Database from 'better-sqlite3';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { CollabError, attachmentIds, idField, numberField, record, reportField, tagsField, textField, MAX_ATTACHMENT_BYTES,
  type CollabAcceptance, type CollabAttachment, type CollabAttempt, type CollabCandidates, type CollabDetail, type CollabEvent, type CollabIdentity, type CollabInboxItem, type CollabJoinResult, type CollabPeer, type CollabReply, type CollabTask, type CollabValidation } from './collab-types.js';

type PeerRow = CollabPeer & { device: string; banned: number; recoveryHash: string | null };
type TaskRow = Omit<CollabTask, 'tags' | 'following'> & { tags: string; following: number; hidden: number };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function recoveryHashField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new CollabError(400, 'invalid_recovery_secret');
  return hash(value);
}
function sameRecoveryHash(stored: string | null, supplied: string | undefined): boolean {
  return !!stored && !!supplied && /^[a-f0-9]{64}$/.test(stored) && timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(supplied, 'hex'));
}

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
      CREATE TABLE IF NOT EXISTS collab_attempts (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES collab_tasks(id), peerId TEXT NOT NULL REFERENCES collab_peers(id), baseRevision INTEGER NOT NULL, status TEXT NOT NULL, direction TEXT NOT NULL, nextStep TEXT NOT NULL, waitReason TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS collab_attempts_task ON collab_attempts(taskId, createdAt);
      CREATE TABLE IF NOT EXISTS collab_validations (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES collab_tasks(id), replyId TEXT NOT NULL REFERENCES collab_replies(id), authorId TEXT NOT NULL REFERENCES collab_peers(id), baseRevision INTEGER NOT NULL, candidateDigest TEXT NOT NULL, outcome TEXT NOT NULL, method TEXT NOT NULL, environment TEXT NOT NULL, evidence TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS collab_validations_task ON collab_validations(taskId, createdAt);
      CREATE TABLE IF NOT EXISTS collab_acceptances (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES collab_tasks(id), replyId TEXT NOT NULL REFERENCES collab_replies(id), authorId TEXT NOT NULL REFERENCES collab_peers(id), validationId TEXT NOT NULL REFERENCES collab_validations(id), baseRevision INTEGER NOT NULL, candidateDigest TEXT NOT NULL, evidence TEXT NOT NULL, createdAt INTEGER NOT NULL);
    `);
    this.db.transaction(() => {
      const hasColumn = (table: string, name: string) => (this.db.pragma(`table_info(${table})`) as { name: string }[]).some(c => c.name === name);
      if (!hasColumn('collab_peers', 'recoveryHash')) this.db.exec('ALTER TABLE collab_peers ADD COLUMN recoveryHash TEXT');
      if (!hasColumn('collab_tasks', 'specRevision')) {
        this.db.exec('ALTER TABLE collab_tasks ADD COLUMN specRevision INTEGER NOT NULL DEFAULT 1; UPDATE collab_tasks SET specRevision = revision');
      }
      if (!hasColumn('collab_replies', 'attemptId')) this.db.exec('ALTER TABLE collab_replies ADD COLUMN attemptId TEXT REFERENCES collab_attempts(id)');
      if (!hasColumn('collab_events', 'subjectId')) this.db.exec('ALTER TABLE collab_events ADD COLUMN subjectId TEXT');
      this.db.exec("UPDATE collab_tasks SET status = 'open' WHERE status = 'review'");
    })();
  }
  peer(identity: CollabIdentity): CollabPeer {
    const row = this.db.prepare('SELECT * FROM collab_peers WHERE device = ?').get(identity.deviceId) as PeerRow | undefined;
    if (!row) throw new CollabError(409, 'peer_not_joined');
    if (row.banned) throw new CollabError(403, 'peer_suspended');
    return { id: row.id, nickname: row.nickname, createdAt: row.createdAt };
  }
  private joiningPeer(identity: CollabIdentity, value: unknown) {
    if (identity.kind !== 'desktop' || identity.role !== 'control') throw new CollabError(403, 'desktop_write_required');
    const body = record(value), id = idField(body.id);
    const nickname = textField(body.nickname, 48, true) || `青竹鲸鱼-${id.slice(0, 4)}`;
    const recoveryHash = recoveryHashField(body.recoverySecret);
    const rows = this.db.prepare('SELECT * FROM collab_peers WHERE device = ? OR id = ?').all(identity.deviceId, id) as PeerRow[];
    if (rows.some(p => p.id !== id)) throw new CollabError(409, 'identity_conflict');
    const peer = rows.find(p => p.id === id);
    if (peer?.banned) throw new CollabError(403, 'peer_suspended');
    const previous = peer && peer.device !== identity.deviceId ? peer.device : undefined;
    if (previous !== undefined) {
      if (!peer!.recoveryHash) throw new CollabError(409, 'identity_recovery_unavailable');
      if (!recoveryHash) throw new CollabError(409, 'identity_recovery_required');
      if (!sameRecoveryHash(peer!.recoveryHash, recoveryHash)) throw new CollabError(409, 'identity_recovery_invalid');
    }
    return { id, nickname, recoveryHash, peer, previous };
  }
  /** Read-only proof checks precede the relay lookup; no database transaction spans network I/O. */
  recoveryDevice(identity: CollabIdentity, value: unknown): string | undefined {
    return identity.kind === 'desktop' ? this.joiningPeer(identity, value).previous : undefined;
  }
  join(identity: CollabIdentity, value: unknown, unregisteredDeviceId?: string): CollabJoinResult {
    if (identity.kind !== 'desktop') return { ...this.peer(identity), recovery: { supported: true, ready: false } };
    return this.db.transaction(() => {
      const { id, nickname, recoveryHash, peer, previous } = this.joiningPeer(identity, value);
      if (previous !== undefined) {
        if (unregisteredDeviceId === undefined) throw new CollabError(503, 'identity_recovery_unsupported');
        if (previous !== unregisteredDeviceId) throw new CollabError(409, 'identity_conflict');
        const changed = this.db.prepare('UPDATE collab_peers SET device = ? WHERE id = ? AND device = ? AND recoveryHash = ? AND banned = 0').run(identity.deviceId, id, previous, recoveryHash);
        if (changed.changes !== 1) throw new CollabError(409, 'identity_conflict');
      } else if (!peer) {
        this.db.prepare('INSERT INTO collab_peers (id, device, nickname, createdAt, recoveryHash) VALUES (?, ?, ?, ?, ?)').run(id, identity.deviceId, nickname, Date.now(), recoveryHash ?? null);
      } else if (!peer.recoveryHash && recoveryHash) {
        this.db.prepare('UPDATE collab_peers SET recoveryHash = ? WHERE id = ? AND device = ? AND recoveryHash IS NULL').run(recoveryHash, id, identity.deviceId);
      }
      const stored = this.db.prepare('SELECT recoveryHash FROM collab_peers WHERE id = ?').get(id) as { recoveryHash: string | null };
      return { ...this.peer(identity), recovery: { supported: true as const, ready: sameRecoveryHash(stored.recoveryHash, recoveryHash) } };
    }).immediate();
  }
  updateProfile(peer: CollabPeer, value: unknown) {
    const nickname = textField(record(value).nickname, 48);
    this.db.prepare('UPDATE collab_peers SET nickname = ? WHERE id = ?').run(nickname, peer.id);
    return { ...peer, nickname };
  }
  private task(peer: CollabPeer, id: string): CollabTask {
    const row = this.db.prepare(`SELECT t.*,
      (SELECT count(*) FROM collab_replies r WHERE r.taskId = t.id) AS replyCount,
      (SELECT count(*) FROM collab_replies r WHERE r.taskId = t.id AND r.kind = 'solution' AND NOT EXISTS(SELECT 1 FROM collab_replies replacement WHERE replacement.taskId = r.taskId AND replacement.replaces = r.id)) AS solutionCount,
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
    if (body.explorationStatus !== undefined && !['active', 'history'].includes(body.explorationStatus as string)) throw new CollabError(400, 'invalid_exploration_status');
    const conditions = ['t.hidden = 0'], args: (string | number)[] = [];
    if (view === 'mine') { conditions.push('t.authorId = ?'); args.push(peer.id); }
    if (view === 'following') { conditions.push('EXISTS(SELECT 1 FROM collab_follows f WHERE f.peerId = ? AND f.taskId = t.id)'); args.push(peer.id); }
    if (view === 'participating') {
      const status = body.explorationStatus === 'active' ? " AND a.status NOT IN ('withdrawn', 'completed')" : body.explorationStatus === 'history' ? " AND a.status IN ('withdrawn', 'completed')" : '';
      conditions.push(`EXISTS(SELECT 1 FROM collab_attempts a WHERE a.peerId = ? AND a.taskId = t.id${status})`); args.push(peer.id);
    }
    if (q) { conditions.push("(instr(lower(t.title), lower(?)) > 0 OR instr(lower(t.description), lower(?)) > 0 OR instr(lower(t.tags), lower(?)) > 0)"); args.push(q, q, q); }
    if (body.status) {
      if (!['open', 'review', 'resolved', 'closed'].includes(body.status as string)) throw new CollabError(400, 'invalid_status');
      conditions.push('t.status = ?'); args.push(body.status === 'review' ? 'open' : body.status as string);
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
  detail(peer: CollabPeer, id: string, offset = 0, subjectId?: string): CollabDetail {
    return this.db.transaction(() => {
      const task = this.task(peer, id);
      if (subjectId !== undefined) {
        const target = this.db.prepare('SELECT rowid, createdAt FROM collab_replies WHERE taskId = ? AND (id = ? OR id = (SELECT replyId FROM collab_validations WHERE taskId = ? AND id = ?))').get(id, subjectId, id, subjectId) as { rowid: number; createdAt: number } | undefined;
        if (target) {
          const before = this.db.prepare('SELECT count(*) AS n FROM collab_replies WHERE taskId = ? AND (createdAt < ? OR (createdAt = ? AND rowid < ?))').get(id, target.createdAt, target.createdAt, target.rowid) as { n: number };
          offset = Math.floor(before.n / 50) * 50;
        } else if (subjectId === id || this.db.prepare('SELECT 1 FROM collab_attempts WHERE taskId = ? AND id = ?').get(id, subjectId)) offset = 0;
        else throw new CollabError(404, 'subject_not_found');
      }
      const replies = (this.db.prepare('SELECT r.*, (SELECT replacement.id FROM collab_replies replacement WHERE replacement.taskId = r.taskId AND replacement.replaces = r.id ORDER BY replacement.createdAt DESC, replacement.rowid DESC LIMIT 1) AS supersededBy FROM collab_replies r WHERE r.taskId = ? ORDER BY r.createdAt, r.rowid LIMIT 51 OFFSET ?').all(id, offset) as (Omit<CollabReply, 'solution' | 'attachments'> & { solution: string | null })[])
        .map(r => ({ ...r, solution: r.solution ? JSON.parse(r.solution) : null, attachments: this.attachments(id, r.id) }));
      const participants = this.db.prepare('SELECT peerId, status, updatedAt FROM collab_participants WHERE taskId = ? ORDER BY updatedAt').all(id) as CollabDetail['participants'];
      const attempts = this.db.prepare('SELECT * FROM collab_attempts WHERE taskId = ? ORDER BY createdAt, rowid').all(id) as CollabAttempt[];
      const validations = this.db.prepare('SELECT * FROM collab_validations WHERE taskId = ? ORDER BY createdAt, rowid').all(id) as CollabValidation[];
      const decision = task.status === 'resolved' ? this.db.prepare('SELECT * FROM collab_acceptances WHERE taskId = ? AND replyId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1').get(id, task.acceptedReplyId) as CollabAcceptance | undefined : undefined;
      return { task, replies: replies.slice(0, 50), participants, attempts, validations, decision: decision ?? null, attachments: this.attachments(id), peers: this.peers([task.authorId, ...replies.map(r => r.authorId), ...participants.map(p => p.peerId), ...attempts.map(a => a.peerId), ...validations.map(v => v.authorId)]), cursor: this.cursor(), replyOffset: offset, hasMore: replies.length > 50 };
    })();
  }
  candidates(peer: CollabPeer, taskId: string, offset = 0): CollabCandidates {
    return this.db.transaction(() => {
      const task = this.task(peer, taskId);
      const rows = this.db.prepare("SELECT r.*, NULL AS supersededBy FROM collab_replies r WHERE r.taskId = ? AND r.kind = 'solution' AND NOT EXISTS(SELECT 1 FROM collab_replies replacement WHERE replacement.taskId = r.taskId AND replacement.replaces = r.id) ORDER BY r.createdAt, r.rowid LIMIT 51 OFFSET ?").all(taskId, offset) as (Omit<CollabReply, 'solution' | 'attachments'> & { solution: string | null })[];
      return { items: rows.slice(0, 50).map(r => ({ ...r, solution: r.solution ? JSON.parse(r.solution) : null, attachments: this.attachments(taskId, r.id) })), hasMore: rows.length > 50, total: task.solutionCount };
    })();
  }
  reply(peer: CollabPeer, taskId: string, replyId: string): CollabReply {
    this.task(peer, taskId);
    const reply = this.db.prepare('SELECT r.*, (SELECT replacement.id FROM collab_replies replacement WHERE replacement.taskId = r.taskId AND replacement.replaces = r.id ORDER BY replacement.createdAt DESC, replacement.rowid DESC LIMIT 1) AS supersededBy FROM collab_replies r WHERE r.taskId = ? AND r.id = ?').get(taskId, replyId) as (Omit<CollabReply, 'solution' | 'attachments'> & { solution: string | null }) | undefined;
    if (!reply) throw new CollabError(404, 'reply_not_found');
    return { ...reply, solution: reply.solution ? JSON.parse(reply.solution) : null, attachments: this.attachments(taskId, replyId) };
  }
  private snapshot(peer: CollabPeer, id: string) {
    const { replyCount: _replies, solutionCount: _solutions, following: _following, ...task } = this.task(peer, id);
    this.db.prepare('INSERT OR IGNORE INTO collab_task_revisions VALUES (?, ?, ?)').run(id, task.revision, JSON.stringify({ ...task, attachments: this.attachments(id) }));
  }
  history(peer: CollabPeer, id: string, offset: number) {
    this.task(peer, id);
    const rows = this.db.prepare('SELECT snapshot FROM collab_task_revisions WHERE taskId = ? ORDER BY revision DESC LIMIT 21 OFFSET ?').all(id, offset) as { snapshot: string }[];
    return { revisions: rows.slice(0, 20).map(r => { const task = JSON.parse(r.snapshot); return { ...task, specRevision: task.specRevision ?? task.revision, status: task.status === 'review' ? 'open' : task.status }; }), hasMore: rows.length > 20 };
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
  private emit(peer: CollabPeer, taskId: string, kind: string, subjectId: string | null = null) {
    const event = this.db.prepare('INSERT INTO collab_events(taskId, actorId, kind, at, subjectId) VALUES (?, ?, ?, ?, ?)').run(taskId, peer.id, kind, Date.now(), subjectId);
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
      const oldFiles = this.attachments(id).map(a => a.id).sort(), files = b.attachments === undefined ? oldFiles : attachmentIds(b.attachments).sort();
      const specChanged = title !== task.title || description !== task.description || acceptance !== task.acceptance || JSON.stringify(oldFiles) !== JSON.stringify(files);
      const status = b.status ?? (specChanged && task.status === 'resolved' ? 'open' : task.status);
      if (!['open', 'closed', task.status].includes(status as string)) throw new CollabError(400, 'accept_solution_to_resolve');
      if (specChanged && status === 'resolved') throw new CollabError(409, 'requirements_need_revalidation');
      this.linkAttachments(peer, files, id);
      for (const old of oldFiles) if (!files.includes(old)) this.db.prepare("DELETE FROM collab_attachment_links WHERE taskId = ? AND replyId = '' AND attachmentId = ?").run(id, old);
      this.db.prepare('UPDATE collab_tasks SET title = ?, description = ?, acceptance = ?, tags = ?, status = ?, revision = revision + 1, specRevision = specRevision + ?, updatedAt = ?, acceptedReplyId = ? WHERE id = ?').run(title, description, acceptance, JSON.stringify(tags), status, specChanged ? 1 : 0, Date.now(), status === 'open' ? null : task.acceptedReplyId, id);
      this.snapshot(peer, id); this.emit(peer, id, 'task.updated'); return this.task(peer, id);
    });
  }
  addReply(peer: CollabPeer, taskId: string, value: unknown) {
    const b = record(value), body = textField(b.body), files = attachmentIds(b.attachments), baseRevision = numberField(b.baseRevision, 1), attemptId = b.attemptId == null ? null : idField(b.attemptId);
    if (!['message', 'solution'].includes(b.kind as string) || !['user', 'dsh'].includes(b.actor as string)) throw new CollabError(400, 'invalid_reply');
    const solution = b.kind === 'solution' ? record(b.solution) : undefined;
    const metadata = solution ? { verification: textField(solution.verification, 16000), limitations: textField(solution.limitations, 8000, true), report: reportField(solution.report) } : null;
    return this.command(peer, b.operationId, 'reply:' + taskId, b, () => {
      const task = this.task(peer, taskId);
      if (baseRevision > task.specRevision) throw new CollabError(409, 'task_changed');
      if (b.kind === 'solution' && ['closed', 'resolved'].includes(task.status)) throw new CollabError(409, 'task_not_open');
      if (attemptId && !this.db.prepare('SELECT 1 FROM collab_attempts WHERE id = ? AND taskId = ? AND peerId = ?').get(attemptId, taskId, peer.id)) throw new CollabError(403, 'attempt_not_owned');
      let replaces: string | null = null;
      if (b.replaces) {
        replaces = idField(b.replaces);
        if (b.kind !== 'solution' || !this.db.prepare("SELECT 1 FROM collab_replies WHERE id = ? AND taskId = ? AND authorId = ? AND kind = 'solution'").get(replaces, taskId, peer.id)) throw new CollabError(403, 'invalid_solution_revision');
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO collab_replies(id, taskId, authorId, actor, kind, body, baseRevision, replaces, createdAt, solution, attemptId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, taskId, peer.id, b.actor, b.kind, body, baseRevision, replaces, Date.now(), metadata ? JSON.stringify(metadata) : null, attemptId);
      this.linkAttachments(peer, files, taskId, id); this.follow(peer, taskId);
      this.db.prepare('UPDATE collab_tasks SET updatedAt = ? WHERE id = ?').run(Date.now(), taskId);
      if (b.kind === 'solution') this.db.prepare("INSERT INTO collab_participants VALUES (?, ?, 'submitted', ?) ON CONFLICT(peerId, taskId) DO UPDATE SET status = 'submitted', updatedAt = excluded.updatedAt").run(peer.id, taskId, Date.now());
      this.emit(peer, taskId, b.kind === 'solution' ? 'solution.submitted' : 'reply.created', id);
      return { id, taskId };
    });
  }
  private candidate(taskId: string, replyId: string) {
    const reply = this.db.prepare("SELECT * FROM collab_replies WHERE id = ? AND taskId = ? AND kind = 'solution'").get(replyId, taskId) as (Omit<CollabReply, 'solution' | 'attachments'> & { solution: string | null }) | undefined;
    if (!reply) throw new CollabError(404, 'solution_not_found');
    if (this.db.prepare('SELECT 1 FROM collab_replies WHERE taskId = ? AND replaces = ?').get(taskId, replyId)) throw new CollabError(409, 'solution_replaced');
    const attachments = this.attachments(taskId, replyId).sort((a, b) => a.id.localeCompare(b.id));
    return hash(JSON.stringify({ ...reply, solution: reply.solution ? JSON.parse(reply.solution) : null, attachments }));
  }
  validate(peer: CollabPeer, taskId: string, value: unknown): CollabValidation {
    const b = record(value), replyId = idField(b.replyId), baseRevision = numberField(b.baseRevision, 1);
    if (!['passed', 'failed', 'inconclusive'].includes(b.outcome as string)) throw new CollabError(400, 'invalid_validation');
    const method = textField(b.method, 8000), environment = textField(b.environment, 8000), evidence = textField(b.evidence, 16000);
    return this.command(peer, b.operationId, 'validate:' + taskId, b, () => {
      const task = this.task(peer, taskId);
      if (baseRevision !== task.specRevision) throw new CollabError(409, 'task_changed');
      const validation: CollabValidation = { id: randomUUID(), taskId, replyId, authorId: peer.id, baseRevision,
        candidateDigest: this.candidate(taskId, replyId), outcome: b.outcome as CollabValidation['outcome'], method, environment, evidence, createdAt: Date.now() };
      this.db.prepare('INSERT INTO collab_validations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(validation.id, taskId, replyId, peer.id, baseRevision, validation.candidateDigest, validation.outcome, method, environment, evidence, validation.createdAt);
      this.follow(peer, taskId); this.emit(peer, taskId, 'validation.created', validation.id);
      return validation;
    });
  }
  accept(peer: CollabPeer, taskId: string, value: unknown) {
    const b = record(value), replyId = idField(b.replyId), revision = numberField(b.revision, 1), validationId = idField(b.validationId);
    return this.command(peer, b.operationId, 'accept:' + taskId, b, () => {
      const task = this.task(peer, taskId);
      if (task.authorId !== peer.id) throw new CollabError(403, 'author_required');
      if (task.revision !== revision || task.status !== 'open') throw new CollabError(409, 'task_changed');
      const digest = this.candidate(taskId, replyId);
      const validation = this.db.prepare('SELECT * FROM collab_validations WHERE id = ? AND taskId = ? AND replyId = ?').get(validationId, taskId, replyId) as CollabValidation | undefined;
      if (!validation || validation.outcome !== 'passed' || validation.baseRevision !== task.specRevision || validation.candidateDigest !== digest) throw new CollabError(409, 'valid_verification_required');
      this.snapshot(peer, taskId);
      this.db.prepare('INSERT INTO collab_acceptances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), taskId, replyId, peer.id, validationId, task.specRevision, digest, validation.evidence, Date.now());
      this.db.prepare("UPDATE collab_tasks SET acceptedReplyId = ?, status = 'resolved', revision = revision + 1, updatedAt = ? WHERE id = ?").run(replyId, Date.now(), taskId);
      this.snapshot(peer, taskId); this.emit(peer, taskId, 'solution.accepted', replyId); return this.task(peer, taskId);
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
      if ((task.status === 'closed' || task.status === 'resolved') && b.status !== 'withdrawn') throw new CollabError(409, 'task_not_open');
      this.db.prepare('INSERT INTO collab_participants VALUES (?, ?, ?, ?) ON CONFLICT(peerId, taskId) DO UPDATE SET status = excluded.status, updatedAt = excluded.updatedAt').run(peer.id, taskId, b.status, Date.now());
      this.follow(peer, taskId); this.emit(peer, taskId, 'participation.updated'); return { status: b.status };
    });
  }
  attempt(peer: CollabPeer, taskId: string, value: unknown): CollabAttempt {
    const b = record(value), id = idField(b.id), baseRevision = numberField(b.baseRevision, 1);
    if (!['working', 'waiting', 'ready', 'paused', 'budget', 'submitted', 'withdrawn', 'completed', 'error'].includes(b.status as string)) throw new CollabError(400, 'invalid_attempt');
    return this.command(peer, b.operationId, 'attempt:' + taskId, b, () => {
      const task = this.task(peer, taskId), prior = this.db.prepare('SELECT * FROM collab_attempts WHERE id = ?').get(id) as CollabAttempt | undefined;
      if (prior && (prior.peerId !== peer.id || prior.taskId !== taskId)) throw new CollabError(403, 'attempt_not_owned');
      if (baseRevision > task.specRevision) throw new CollabError(409, 'task_changed');
      if ((task.status === 'closed' || task.status === 'resolved') && (!prior || ['working', 'waiting', 'ready'].includes(b.status as string))) throw new CollabError(409, 'task_not_open');
      const attempt: CollabAttempt = { id, taskId, peerId: peer.id, baseRevision, status: b.status as CollabAttempt['status'],
        direction: b.direction === undefined ? prior?.direction ?? '' : textField(b.direction, 4000, true),
        nextStep: b.nextStep === undefined ? prior?.nextStep ?? '' : textField(b.nextStep, 4000, true),
        waitReason: b.waitReason === undefined ? prior?.waitReason ?? '' : textField(b.waitReason, 4000, true),
        createdAt: prior?.createdAt ?? Date.now(), updatedAt: Date.now() };
      this.db.prepare('INSERT INTO collab_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET baseRevision = excluded.baseRevision, status = excluded.status, direction = excluded.direction, nextStep = excluded.nextStep, waitReason = excluded.waitReason, updatedAt = excluded.updatedAt').run(id, taskId, peer.id, baseRevision, attempt.status, attempt.direction, attempt.nextStep, attempt.waitReason, attempt.createdAt, attempt.updatedAt);
      const states = (this.db.prepare('SELECT status FROM collab_attempts WHERE taskId = ? AND peerId = ?').all(taskId, peer.id) as { status: CollabAttempt['status'] }[]).map(a => a.status);
      const status = states.includes('working') ? 'working' : states.some(s => ['waiting', 'ready', 'paused', 'budget', 'error'].includes(s)) ? 'waiting' : states.some(s => ['submitted', 'completed'].includes(s)) ? 'submitted' : 'withdrawn';
      this.db.prepare('INSERT INTO collab_participants VALUES (?, ?, ?, ?) ON CONFLICT(peerId, taskId) DO UPDATE SET status = excluded.status, updatedAt = excluded.updatedAt').run(peer.id, taskId, status, attempt.updatedAt);
      this.follow(peer, taskId); this.emit(peer, taskId, 'attempt.updated', id);
      return attempt;
    });
  }
  sync(peer: CollabPeer, after: number) {
    return this.db.transaction(() => {
      const cursor = this.cursor();
      const events = this.db.prepare("SELECT e.*, r.attemptId AS sourceAttemptId FROM collab_events e JOIN collab_tasks t ON t.id = e.taskId LEFT JOIN collab_replies r ON r.id = e.subjectId AND r.taskId = e.taskId AND e.kind IN ('reply.created', 'solution.submitted') WHERE e.id > ? AND t.hidden = 0 ORDER BY e.id LIMIT 201").all(after) as CollabEvent[];
      const visible = events.slice(0, 200);
      return { events: visible, cursor: events.length > 200 ? visible.at(-1)!.id : cursor, hasMore: events.length > 200, reset: after > cursor, unread: this.unread(peer) };
    })();
  }
  unread(peer: CollabPeer) { return (this.db.prepare('SELECT count(*) AS n FROM collab_inbox i JOIN collab_events e ON e.id = i.eventId JOIN collab_tasks t ON t.id = e.taskId WHERE peerId = ? AND read = 0 AND t.hidden = 0').get(peer.id) as { n: number }).n; }
  inbox(peer: CollabPeer, offset = 0) {
    const rows = this.db.prepare("SELECT e.*, r.attemptId AS sourceAttemptId, i.read, t.title FROM collab_inbox i JOIN collab_events e ON e.id = i.eventId JOIN collab_tasks t ON t.id = e.taskId LEFT JOIN collab_replies r ON r.id = e.subjectId AND r.taskId = e.taskId AND e.kind IN ('reply.created', 'solution.submitted') WHERE i.peerId = ? AND t.hidden = 0 ORDER BY e.id DESC LIMIT 51 OFFSET ?").all(peer.id, offset) as (CollabEvent & { read: number; title: string })[];
    return { items: rows.slice(0, 50).map(r => ({ ...r, read: !!r.read })) as CollabInboxItem[], hasMore: rows.length > 50, unread: this.unread(peer), cursor: this.cursor() };
  }
  markRead(peer: CollabPeer, value: unknown) {
    const b = record(value);
    if (b.eventIds !== undefined) {
      if (!Array.isArray(b.eventIds) || b.eventIds.length > 200) throw new CollabError(400, 'invalid_event_ids');
      const ids = [...new Set(b.eventIds.map(id => numberField(id, 1)))];
      if (ids.length) this.db.prepare(`UPDATE collab_inbox SET read = 1 WHERE peerId = ? AND eventId IN (${ids.map(() => '?').join(',')})`).run(peer.id, ...ids);
    } else {
      const through = numberField(b.through, 0);
      if (b.taskId !== undefined) {
        const taskId = idField(b.taskId); this.task(peer, taskId);
        this.db.prepare('UPDATE collab_inbox SET read = 1 WHERE peerId = ? AND eventId <= ? AND eventId IN (SELECT id FROM collab_events WHERE taskId = ?)').run(peer.id, through, taskId);
      } else this.db.prepare('UPDATE collab_inbox SET read = 1 WHERE peerId = ? AND eventId <= ?').run(peer.id, through);
    }
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
