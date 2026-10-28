import { emptyCounts, type ExecutionReport, type UsageCounts } from '../../services/relay/src/collab-types.ts';

export type CollabSessionInspection = { meta: { id: string; parentSession?: string; origin?: string }; inheritedEventCount: number; events: readonly any[] };
export type DeriveTurnUsage = (events: readonly any[]) => ({ uncachedInputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; routes?: { provider: string; model: string }[] } | undefined);
const keys = Object.keys(emptyCounts()) as (keyof UsageCounts)[];
function sum(values: (UsageCounts | undefined)[]): UsageCounts {
  const out = emptyCounts();
  if (!values.length) return out;
  for (const key of keys) {
    const counts = values.map(v => v?.[key]);
    if (counts.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
      const total = (counts as number[]).reduce((a, b) => a + b, 0);
      if (Number.isSafeInteger(total)) out[key] = total;
    }
  }
  return out;
}
function normalized(value: ReturnType<DeriveTurnUsage>): UsageCounts | undefined {
  if (!value) return;
  return { uncachedInputTokens: value.uncachedInputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens,
    cacheReadTokens: value.cacheReadTokens ?? null, cacheWriteTokens: value.cacheWriteTokens ?? null, reasoningTokens: value.reasoningTokens ?? null };
}
function attemptUsage(event: any, derive: DeriveTurnUsage) {
  const { turn, step } = event.data;
  return derive([
    { type: 'turn/start', data: { turn } }, { type: 'step/start', data: { turn, step } }, event,
    { type: 'step/end', data: { turn, step } }, { type: 'turn/end', data: { turn, reason: 'completed' } },
  ]);
}
/** Known billed attempts are a lower bound usable before the current turn has ended. */
export function settledCollabTokens(inspections: readonly CollabSessionInspection[], derive: DeriveTurnUsage): number {
  return inspections.reduce((sum, inspection) => sum + inspection.events.slice(inspection.inheritedEventCount)
    .filter(e => e.type === 'assistant/message' || e.type === 'assistant/attempt')
    .reduce((n, event) => n + (attemptUsage(event, derive)?.totalTokens ?? 0), 0), 0);
}

/** Account only owned event suffixes; one settled attempt is counted once, never both its stream and message. */
export function collectCollabUsage(inspections: readonly CollabSessionInspection[], derive: DeriveTurnUsage): ExecutionReport['usage'] {
  const turns: (UsageCounts | undefined)[] = [], routes = new Map<string, { provider: string; model: string; values: (UsageCounts | undefined)[] }>();
  let attempts = 0, incomplete = false;
  for (const inspection of inspections) {
    let turn: any[] | undefined;
    for (const event of inspection.events.slice(inspection.inheritedEventCount)) {
      if (event.type === 'turn/start') { if (turn) incomplete = true; turn = [event]; continue; }
      if (!turn) continue;
      turn.push(event);
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        attempts++;
        const source = event.type === 'assistant/message' ? event.data.message?.source : undefined;
        const provider = typeof source?.provider === 'string' && source.provider ? source.provider : '未提供';
        const model = typeof source?.model === 'string' && source.model ? source.model : '未提供';
        const key = JSON.stringify([provider, model]);
        let route = routes.get(key); if (!route) { route = { provider, model, values: [] }; routes.set(key, route); }
        route.values.push(normalized(attemptUsage(event, derive)));
      }
      if (event.type === 'turn/end') {
        if (turn.some(e => e.type === 'step/start')) turns.push(normalized(derive(turn)));
        turn = undefined;
      }
    }
    if (turn) incomplete = true;
  }
  if (incomplete) turns.push(undefined);
  const totals = sum(turns);
  return { status: turns.length > 0 && turns.every(v => v !== undefined) && !incomplete ? 'complete' : turns.some(v => v !== undefined) ? 'partial' : 'unavailable',
    source: 'client-runtime', totals, routes: [...routes.values()].map(({ values, ...route }) => ({ ...route, ...sum(values) })), sessions: inspections.length, attempts };
}

export function collabOutput(inspection: CollabSessionInspection): string {
  const events = inspection.events.slice(inspection.inheritedEventCount);
  const last = [...events].reverse().find(e => e.type === 'assistant/message' && !e.data.interrupted);
  return last?.data.message?.content?.filter((part: any) => part.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n').slice(0, 48 * 1024) ?? '';
}
