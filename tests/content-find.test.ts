import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContentFindAction, readContentFindId, readContentFindState } from '../src/shared/content-find.ts';

test('external find IPC retains literal Unicode queries and accepts only query, navigation and close actions', () => {
  const id = 'content-find-1';
  assert.deepEqual(readContentFindAction({ id, type: 'query', query: 'a+b[0] 中文🙂' }), { id, type: 'query', query: 'a+b[0] 中文🙂' });
  assert.deepEqual(readContentFindAction({ id, type: 'navigate', forward: false }), { id, type: 'navigate', forward: false });
  assert.deepEqual(readContentFindAction({ id, type: 'close' }), { id, type: 'close' });
  for (const value of [null, {}, { id, type: 'navigate', forward: 'false' }, { id, type: 'query', query: 'x'.repeat(4097) }, { id, type: 'delete' }]) assert.throws(() => readContentFindAction(value));
  for (const value of ['', '../file', 'x'.repeat(129), null]) assert.throws(() => readContentFindId(value));
});

test('external find state validates bounded fields and match ordinals and does not forward extra fields', () => {
  const state = { id: 'find-2', query: '🙂', matches: 2, active: 1, limited: false, error: '' };
  assert.deepEqual(readContentFindState({ ...state, unrelated: 'private' }), state);
  for (const invalid of [{ matches: -1 }, { active: 3 }, { active: .5 }, { limited: 'true' }, { error: 'x'.repeat(4097) }, { query: null }]) assert.throws(() => readContentFindState({ ...state, ...invalid }));
});
