import type { TaskEvent, TaskOutcome } from '../shared/task-notifications.ts';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Session = { id: string; header: { origin?: string; parentSession?: string }; firstLiveSeq: number };
type Context = {
  on(event: 'session/event', listener: (session: Session, event: { type: string; seq: number; data: any }) => void): unknown;
  on(event: 'session/disposed', listener: (session: Session) => void): unknown;
  get(name: 'sessionTitle'): { get(session: Session): { title: string } | undefined } | undefined;
  get(name: 'sessionPersistence'): { locate(header: Session['header']): { kind: string; path: string } | undefined } | undefined;
};

/** Live turn boundaries only: restored history and inner subagents never notify. */
export function installTaskNotifications(ctx: Context, publish: (event: TaskEvent) => void) {
  const turns = new Map<string, { turn: number; enteredStep: boolean }>();
  const title = (session: Session) => (ctx.get('sessionTitle')?.get(session)?.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  ctx.on('session/event', (session, event) => {
    if (session.header.origin === 'subagent' || event.seq < session.firstLiveSeq) return;
    if (event.type === 'turn/start') {
      // Side's reserved on-disk marker is its ownership contract. Its temporary
      // fork must never become a main conversation through a notification click.
      if (session.header.parentSession) {
        const location = ctx.get('sessionPersistence')?.locate(session.header);
        if (location?.kind === 'jsonl' && existsSync(join(dirname(location.path), '.dsh-side-chat-v2.json'))) return;
      }
      turns.set(session.id, { turn: event.data.turn, enteredStep: false });
      publish({ kind: 'started', sessionId: session.id, turn: event.data.turn, title: title(session) });
      return;
    }
    if (event.type !== 'step/start' && event.type !== 'turn/end') return;
    const active = turns.get(session.id);
    if (!active || event.data.turn !== active.turn) return;
    if (event.type === 'step/start') { active.enteredStep = true; return; }
    if (event.type !== 'turn/end') return;
    turns.delete(session.id);
    const reason = event.data.reason;
    let outcome: TaskOutcome = 'stopped';
    if (reason.kind === 'completed' && active.enteredStep) outcome = 'completed';
    else if (['error', 'max-tokens', 'interrupted'].includes(reason.kind) ||
      reason.kind === 'blocked' && active.enteredStep ||
      reason.kind === 'aborted' && !['user', 'parent', 'disposed'].includes(reason.reason?.kind)) outcome = 'interrupted';
    publish({ kind: 'ended', sessionId: session.id, turn: active.turn, title: title(session), outcome });
  });
  ctx.on('session/disposed', session => {
    const active = turns.get(session.id);
    if (!active) return;
    turns.delete(session.id);
    publish({ kind: 'ended', sessionId: session.id, turn: active.turn, title: title(session), outcome: 'stopped' });
  });
}
