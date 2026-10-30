import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectCollabUsage, settledCollabTokens, collabOutput } from '../src/runtime/collab-usage.ts';

const require = createRequire(new URL('../.runtime/package.json', import.meta.url));
const { deriveTurnTokenUsage } = await import(pathToFileURL(join(dirname(require.resolve('@deepseek-ai/dsh-token-meter/package.json')), 'lib/types/turn-usage.js')).href);
const event = (type: string, data: any = {}) => ({ type, data });
function turn(turn: number, input = 10, model = 'fixture-model') {
  return [event('turn/start', { turn }), event('step/start', { turn, step: 0 }),
    event('assistant/message', { turn, step: 0, stream: [], message: { source: { provider: 'fixture', model }, content: [{ type: 'reasoning', text: 'PRIVATE_THOUGHT' }, { type: 'text', text: 'Public solution' }] }, usage: { inputTokens: input, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 2, totalTokens: input + 10 } }),
    event('step/end', { turn, step: 0 }), event('turn/end', { turn, reason: 'completed' })];
}
test('accounting sums disjoint buckets, routes and child-owned suffixes without double-counting reasoning or inherited events', () => {
  const parent = { meta: { id: 'root' }, inheritedEventCount: 0, events: [...turn(1), ...turn(2, 20, 'second')] };
  const child = { meta: { id: 'child', parentSession: 'root', origin: 'subagent' }, inheritedEventCount: 5, events: [...turn(1), ...turn(2, 30)] };
  const usage = collectCollabUsage([parent, child], deriveTurnTokenUsage);
  assert.equal(usage.status, 'complete'); assert.equal(usage.attempts, 3);
  assert.deepEqual(usage.totals, { uncachedInputTokens: 60, cacheReadTokens: 9, cacheWriteTokens: 6, outputTokens: 15, reasoningTokens: 6, totalTokens: 90 });
  assert.equal(usage.routes.length, 2);
  assert.equal(collabOutput(parent), 'Public solution');
});
test('unknown usage and incomplete lifecycle never turn into zero or a falsely complete total', () => {
  const missing = turn(2); delete missing[2].data.usage;
  const result = collectCollabUsage([{ meta: { id: 'root' }, inheritedEventCount: 0, events: [...turn(1), ...missing] }], deriveTurnTokenUsage);
  assert.equal(result.status, 'partial'); assert.equal(result.totals.totalTokens, null); assert.equal(result.totals.cacheReadTokens, null);
  const unfinished = collectCollabUsage([{ meta: { id: 'root' }, inheritedEventCount: 0, events: turn(1).slice(0, -1) }], deriveTurnTokenUsage);
  assert.equal(unfinished.status, 'unavailable'); assert.equal(unfinished.totals.outputTokens, null);
  assert.equal(settledCollabTokens([{ meta: { id: 'root' }, inheritedEventCount: 0, events: [...turn(1).slice(0, -1), ...missing.slice(1, -1)] }], deriveTurnTokenUsage), 20, 'A settled attempt remains a budget lower bound even before turn/end or when another attempt is unknown');
});
