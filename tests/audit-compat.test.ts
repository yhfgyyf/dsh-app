import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the exact patched runtime function, including failed partial registration.
const source = await readFile(new URL('../.runtime/node_modules/@deepseek-ai/dsh-tool-cordis/lib/index.js', import.meta.url), 'utf8');
const start = source.indexOf('const hostInspectLeases = new WeakMap();');
const end = source.indexOf('/** Register the Cordis tools and explicit', start);
assert.ok(start >= 0 && end > start, 'Prepare the Audit-compatible runtime before testing.');
const providers = ['Service', 'Event', 'Builtin', 'Tool'];
const acquire = new Function('hostInspectProviders', source.slice(start, end) + '\nreturn acquireHostInspectProviders;')((root: any) => providers.map(id => ({ manifest: { id }, root })));

function fixture() {
  const registered = new Map<string, any>();
  const root = {};
  return { root, registered, context: { root, cordisInspect: {
    register(provider: any) {
      if (registered.has(provider.manifest.id)) throw new Error('duplicate ' + provider.manifest.id);
      registered.set(provider.manifest.id, provider);
      return () => { if (registered.get(provider.manifest.id) === provider) registered.delete(provider.manifest.id); };
    },
  } } };
}

test('Host inspect leases survive one preset unloading and dispose after the final owner', () => {
  const { context, root, registered } = fixture();
  const first = acquire(context), second = acquire({ ...context });
  assert.equal(registered.size, 4);
  assert.ok([...registered.values()].every(provider => provider.root === root));
  first(); first();
  assert.equal(registered.size, 4);
  second(); assert.equal(registered.size, 0);
  const later = acquire(context); assert.equal(registered.size, 4); later();
  assert.equal(registered.size, 0);
});

test('an unrelated provider collision stays loud and rolls back partial registration', () => {
  const { context, registered } = fixture();
  const existing = { owner: 'unrelated-plugin' };
  registered.set('Builtin', existing);
  assert.throws(() => acquire(context), /duplicate Builtin/);
  assert.deepEqual([...registered], [['Builtin', existing]]);
  registered.delete('Builtin');
  const release = acquire(context); assert.equal(registered.size, 4); release();
});
