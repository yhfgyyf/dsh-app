export type TaskOutcome = 'completed' | 'interrupted' | 'stopped';
export type TaskEvent = { kind: 'runtime-interrupted' } | ({ sessionId: string; turn: number; title: string } &
  ({ kind: 'started' } | { kind: 'ended'; outcome: TaskOutcome }));
export type TaskNotice = { sessionId: string; turn: number; title: string; outcome: Exclude<TaskOutcome, 'stopped'> };

export function notificationSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

export function readTaskEvent(value: unknown): TaskEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const event = value as Record<string, unknown>;
  if (event.kind === 'runtime-interrupted') return { kind: 'runtime-interrupted' };
  if (!['started', 'ended'].includes(event.kind as string) || !notificationSessionId(event.sessionId) ||
      !Number.isSafeInteger(event.turn) || (event.turn as number) < 0 || typeof event.title !== 'string' ||
      event.title.length > 180 || /[\u0000-\u001f\u007f]/.test(event.title)) return;
  if (event.kind === 'ended' && !['completed', 'interrupted', 'stopped'].includes(event.outcome as string)) return;
  const task = { sessionId: event.sessionId, turn: event.turn as number, title: event.title };
  return event.kind === 'ended' ? { kind: 'ended', ...task, outcome: event.outcome as TaskOutcome } : { kind: 'started', ...task };
}
