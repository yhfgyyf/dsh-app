import Database from 'better-sqlite3';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export type Binding = { id: string; device: string; account: string; name: string; invite: string; role: string; state: string; expires: number };

/** Private-deployment schema. No chat, attachments or end-to-end keys are stored here. */
export class PrivateStore {
  db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_accounts (email TEXT PRIMARY KEY, salt TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_codes (hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_devices (id TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_invites (id TEXT PRIMARY KEY, device TEXT NOT NULL, secret TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS remote_bindings (id TEXT PRIMARY KEY, device TEXT NOT NULL, account TEXT NOT NULL, name TEXT NOT NULL, invite TEXT NOT NULL, token TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', state TEXT NOT NULL DEFAULT 'pending', expires INTEGER NOT NULL);
    `);
    if (!(this.db.prepare('PRAGMA table_info(remote_invites)').all() as { name: string }[]).some(c => c.name === 'qr')) {
      this.db.exec('ALTER TABLE remote_invites ADD COLUMN qr INTEGER NOT NULL DEFAULT 0');
    }
  }
  provision(email: string, password: string) {
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 1024) throw new Error('Account email and password (12+ characters) required');
    const salt = token();
    this.db.prepare('INSERT INTO remote_accounts VALUES (?, ?, ?)').run(email, salt, scryptSync(password, salt, 32).toString('hex'));
  }
  login(email: string, password: string): boolean {
    const a = this.db.prepare('SELECT * FROM remote_accounts WHERE email = ?').get(email) as any;
    const actual = scryptSync(password, a?.salt ?? 'absent-account', 32);
    return !!a && timingSafeEqual(actual, Buffer.from(a.password, 'hex'));
  }
  registration(account: string) {
    if (!this.db.prepare('SELECT email FROM remote_accounts WHERE email = ?').get(account)) throw new Error('Account not found');
    const code = token();
    this.db.prepare('INSERT INTO remote_codes VALUES (?, ?, ?)').run(hash(code), account, Date.now() + 600_000);
    return code;
  }
  register(code: string, name: string) {
    return this.db.transaction(() => {
      const c = this.db.prepare('SELECT * FROM remote_codes WHERE hash = ? AND expires > ?').get(hash(code), Date.now()) as any;
      if (!c) return undefined;
      const deviceId = token(), deviceToken = token();
      this.db.prepare('DELETE FROM remote_codes WHERE hash = ?').run(hash(code));
      this.db.prepare('INSERT INTO remote_devices VALUES (?, ?, ?, ?)').run(deviceId, c.account, name, hash(deviceToken));
      return { deviceId, deviceToken };
    })();
  }
  device(id: string, secret: string) {
    return this.db.prepare('SELECT id, account, name FROM remote_devices WHERE id = ? AND token = ?').get(id, hash(secret)) as { id: string; account: string; name: string } | undefined;
  }
  invite(device: string, qr = false) {
    return this.db.transaction(() => {
      this.cancel(device);
      const inviteId = token(), claimSecret = token(), expiresAt = Date.now() + 120_000;
      this.db.prepare('INSERT INTO remote_invites (id, device, secret, expires, used, qr) VALUES (?, ?, ?, ?, 0, ?)').run(inviteId, device, hash(claimSecret), expiresAt, qr ? 1 : 0);
      return { inviteId, claimSecret, expiresAt };
    })();
  }
  cancel(device: string) {
    this.db.prepare("UPDATE remote_bindings SET state = 'revoked' WHERE device = ? AND state = 'pending'").run(device);
    this.db.prepare('DELETE FROM remote_invites WHERE device = ?').run(device);
  }
  claim(account: string, inviteId: string, secret: string, name: string) {
    return this.db.transaction(() => {
      const invite = this.db.prepare('SELECT i.*, d.account FROM remote_invites i JOIN remote_devices d ON d.id = i.device WHERE i.id = ? AND i.secret = ? AND i.used = 0 AND i.expires > ? AND d.account = ?').get(inviteId, hash(secret), Date.now(), account) as any;
      if (!invite) return undefined;
      const count = this.db.prepare("SELECT count(*) AS n FROM remote_bindings WHERE device = ? AND state != 'revoked'").get(invite.device) as any;
      if (count.n >= 32) return undefined;
      this.db.prepare('UPDATE remote_invites SET used = 1 WHERE id = ?').run(inviteId);
      const bindingId = token(), bindingToken = token();
      this.db.prepare('INSERT INTO remote_bindings (id, device, account, name, invite, token, expires) VALUES (?, ?, ?, ?, ?, ?, ?)').run(bindingId, invite.device, account, name, inviteId, hash(bindingToken), invite.expires);
      return { bindingId, bindingToken, deviceId: invite.device };
    })();
  }
  claimQr(inviteId: string, secret: string, name: string) {
    const invite = this.db.prepare('SELECT d.account FROM remote_invites i JOIN remote_devices d ON d.id = i.device WHERE i.id = ? AND i.secret = ? AND i.qr = 1 AND i.used = 0 AND i.expires > ?').get(inviteId, hash(secret), Date.now()) as { account: string } | undefined;
    return invite ? this.claim(invite.account, inviteId, secret, name) : undefined;
  }
  bind(device: string, name: string) {
    return this.db.transaction(() => {
      const d = this.db.prepare('SELECT account FROM remote_devices WHERE id = ?').get(device) as { account: string } | undefined;
      const count = this.db.prepare("SELECT count(*) AS n FROM remote_bindings WHERE device = ? AND state != 'revoked'").get(device) as { n: number };
      if (!d || count.n >= 32) return undefined;
      const bindingId = token(), bindingToken = token();
      this.db.prepare("INSERT INTO remote_bindings (id, device, account, name, invite, token, role, state, expires) VALUES (?, ?, ?, ?, '', ?, 'control', 'approved', 0)").run(bindingId, device, d.account, name, hash(bindingToken));
      return { bindingId, bindingToken, deviceId: device };
    })();
  }
  bindingStates(device: string) {
    return this.db.prepare('SELECT id, state FROM remote_bindings WHERE device = ?').all(device);
  }
  selfRevoke(id: string, secret: string) {
    const binding = this.db.prepare('SELECT id, device FROM remote_bindings WHERE id = ? AND token = ?').get(id, hash(secret)) as { id: string; device: string } | undefined;
    if (binding) this.revoke(binding.device, binding.id);
    return binding;
  }
  binding(id: string, secret: string): Binding | undefined {
    return this.db.prepare("SELECT id, device, account, name, invite, role, state, expires FROM remote_bindings WHERE id = ? AND token = ? AND state != 'revoked' AND (state = 'approved' OR expires > ?)").get(id, hash(secret), Date.now()) as Binding | undefined;
  }
  pending(device: string) {
    return this.db.prepare("SELECT id, account, name, invite FROM remote_bindings WHERE device = ? AND state = 'pending' AND expires > ?").all(device, Date.now());
  }
  approve(device: string, id: string, role: string) {
    return this.db.prepare("UPDATE remote_bindings SET state = 'approved', role = ? WHERE device = ? AND id = ? AND state = 'pending' AND expires > ?").run(role, device, id, Date.now()).changes === 1;
  }
  revoke(device: string, id: string) {
    this.db.prepare("UPDATE remote_bindings SET state = 'revoked' WHERE device = ? AND id = ?").run(device, id);
  }
}
