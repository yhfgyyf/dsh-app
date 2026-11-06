import type { TaskEvent, TaskNotice } from '../shared/task-notifications.ts';

type Options = {
  badge(count: number): void;
  notify(notice: TaskNotice, open: () => void): () => void;
  openSession(sessionId: string): void;
};

/** Main-process ownership keeps reminders intact through renderer reloads. */
export class TaskNotifications {
  private active = new Map<string, { turn: number; title: string }>();
  private unread = new Map<string, { notice: TaskNotice; close: () => void }>();
  private viewed?: string;
  private focused = false;
  private disposed = false;
  private options: Options;
  constructor(options: Options) { this.options = options; options.badge(0); }
  get count() { return this.unread.size; }
  setView(sessionId?: string) { this.viewed = sessionId; this.readCurrent(); }
  setFocused(focused: boolean) { this.focused = focused; this.readCurrent(); }
  receive(event: TaskEvent) {
    if (this.disposed) return;
    if (event.kind === 'runtime-interrupted') {
      const active = [...this.active];
      for (const [sessionId, task] of active) this.receive({ kind: 'ended', sessionId, ...task, outcome: 'interrupted' });
      return;
    }
    if (event.kind === 'started') { this.active.set(event.sessionId, { turn: event.turn, title: event.title }); return; }
    if (this.active.get(event.sessionId)?.turn !== event.turn) return;
    this.active.delete(event.sessionId);
    if (event.outcome === 'stopped' || this.focused && event.sessionId === this.viewed) return;
    const notice: TaskNotice = { sessionId: event.sessionId, turn: event.turn, title: event.title, outcome: event.outcome };
    this.unread.get(event.sessionId)?.close();
    const pending = { notice, close: () => {} };
    this.unread.set(event.sessionId, pending);
    this.options.badge(this.count);
    // Notification denial must never lose the unread badge or interrupt a task.
    try { pending.close = this.options.notify(notice, () => { this.read(event.sessionId); this.options.openSession(event.sessionId); }); }
    catch { /* The platform adapter reports native failures without task data. */ }
  }
  private readCurrent() { if (this.focused && this.viewed) this.read(this.viewed); }
  private read(sessionId: string) {
    const unread = this.unread.get(sessionId);
    if (!unread) return;
    this.unread.delete(sessionId);
    unread.close(); this.options.badge(this.count);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active.clear();
    for (const pending of this.unread.values()) pending.close();
    this.unread.clear(); this.options.badge(0);
  }
}
