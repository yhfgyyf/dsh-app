import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertSelectionQuote } from '../src/renderer/quote-actions.ts';

function fixture(existing = false) {
  let owner = 'main', side = existing ? 'side' : undefined;
  const inserted: { id: string; text: string }[] = [], closed: string[] = [];
  let opens = 0;
  const chats = {
    getSnapshot: () => ({ main: side ? { childId: side } : undefined }),
    async open() { opens++; side ??= 'side'; return { childId: side }; },
    owns: (parent: string, child: string) => parent === 'main' && child === side,
    async close(_parent: string, child: string) { closed.push(child); side = undefined; },
  };
  const ctx = {
    get: () => chats,
    sidebarRight: { mounted: { getSnapshot: () => owner } },
    sessions: { scope: (id: string) => ({ id }) },
    conversation: { input: { for: (scope: unknown) => ({
      insertQuote(text: string) { inserted.push({ id: (scope as { id: string }).id, text }); return true; }, focus() {},
    }) } },
  };
  return { ctx, inserted, closed, opens: () => opens, changeOwner() { owner = 'another'; } };
}

test('main quote from an owned side conversation targets the main draft without opening a side', async () => {
  const f = fixture(true);
  const id = await insertSelectionQuote(f.ctx, async () => {}, { target: 'main', owner: 'main', sourceId: 'side', text: '中文🙂\n<script>literal</script>' });
  assert.equal(id, 'main'); assert.equal(f.opens(), 0);
  assert.deepEqual(f.inserted, [{ id: 'main', text: '中文🙂\n<script>literal</script>' }]);
});

test('main and side selections both reuse the already-open side draft', async () => {
  const f = fixture(true);
  for (const sourceId of ['main', 'side']) {
    assert.equal(await insertSelectionQuote(f.ctx, async () => {}, { target: 'side', owner: 'main', sourceId, text: sourceId }), 'side');
  }
  assert.deepEqual(f.inserted, [{ id: 'side', text: 'main' }, { id: 'side', text: 'side' }]);
  assert.deepEqual(f.closed, []);
});

for (const existing of [false, true]) test(`session switch while side input mounts keeps other drafts intact (${existing ? 'existing' : 'fresh'} side)`, async () => {
  const f = fixture(existing);
  await assert.rejects(insertSelectionQuote(f.ctx, async () => { f.changeOwner(); }, { target: 'side', owner: 'main', sourceId: 'main', text: 'captured' }), /切换/);
  assert.deepEqual(f.inserted, []);
  assert.deepEqual(f.closed, existing ? [] : ['side']);
});

test('stale side selection and empty text cannot open or change any destination', async () => {
  const f = fixture();
  await assert.rejects(insertSelectionQuote(f.ctx, async () => {}, { target: 'side', owner: 'main', sourceId: 'closed-side', text: 'stale' }), /切换/);
  await assert.rejects(insertSelectionQuote(f.ctx, async () => {}, { target: 'main', owner: 'main', sourceId: 'main', text: ' ' }), /选中内容无效/);
  assert.equal(f.opens(), 0); assert.deepEqual(f.inserted, []);
});
