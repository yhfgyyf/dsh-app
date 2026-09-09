import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { assertBootGraph, DESKTOP_PLUGIN_ID, withDesktopPlugin } from '../src/shared/dsh-boot.ts';
import type { BootGraph } from '../src/shared/dsh-boot.ts';

const modules = ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-theme', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-modules'];
function fixture(): BootGraph {
  const entries = modules.map((name) => ({
    id: name, url: `/plugins/${name}/client.js`, rev: 'test-revision',
  }));
  return {
    rev: 'host-revision',
    hostExtension: { preserved: true },
    entries,
    batches: [{ url: '/plugins/??all', rev: 'all-revision', phase: 'application', entries: entries.map((entry: { id: string }) => entry.id) }],
  };
}

test('adds the desktop plugin without changing any original modules or batch assignments', () => {
  const graph = fixture();
  const original = structuredClone(graph);
  const result = withDesktopPlugin(graph, 'desktop.1');
  assert.deepEqual(graph, original);
  assert.deepEqual(result.entries.slice(0, -1), graph.entries);
  assert.deepEqual(result.batches.slice(0, -1), graph.batches);
  assert.equal(result.rev, graph.rev);
  assert.deepEqual(result.hostExtension, graph.hostExtension);
  assert.equal(result.entries.at(-1)?.id, DESKTOP_PLUGIN_ID);
  assert.equal(result.entries.length, graph.entries.length + 1);
  assert.equal(result.batches.at(-1)?.phase, 'application');
});

test('rejects duplicate desktop installation and resource collisions', () => {
  const result = withDesktopPlugin(fixture(), 'desktop.1');
  assert.throws(() => withDesktopPlugin(result, 'desktop.1'));
  const collision = fixture();
  collision.batches[0].url = '/__dsh_desktop__/plugin.js?rev=desktop.1';
  assert.throws(() => withDesktopPlugin(collision, 'desktop.1'));
});

test('rejects malformed graphs and incomplete batch mappings', () => {
  const malformed: unknown[] = [null, {}, { rev: 1, entries: [], batches: [] }];
  const duplicateEntry = fixture();
  duplicateEntry.entries.push(duplicateEntry.entries[0]);
  malformed.push(duplicateEntry);
  const unknownBatchEntry = fixture();
  unknownBatchEntry.batches[0].entries.push('missing-module');
  malformed.push(unknownBatchEntry);
  const unassigned = fixture();
  unassigned.batches[0].entries.pop();
  malformed.push(unassigned);
  const twiceAssigned = fixture();
  twiceAssigned.batches.push({ ...twiceAssigned.batches[0], url: '/another-batch' });
  malformed.push(twiceAssigned);
  const emptyBatch = fixture();
  emptyBatch.batches[0].entries = [];
  malformed.push(emptyBatch);
  const wrongPhase = fixture();
  (wrongPhase.batches[0] as { phase: string }).phase = 'other';
  malformed.push(wrongPhase);
  const wrongInject = fixture();
  (wrongInject.entries[0] as { inject: unknown }).inject = [null];
  malformed.push(wrongInject);
  for (const graph of malformed) assert.throws(() => assertBootGraph(graph));
});

test('requires the original layout, theme and renderer services', () => {
  const graph = fixture();
  graph.entries = [];
  graph.batches = [];
  assert.throws(() => withDesktopPlugin(graph, 'desktop.1'), /前端插件/);
  for (const revision of ['', '../evil', 'rev?token=x', 'x'.repeat(81)]) {
    assert.throws(() => withDesktopPlugin(fixture(), revision));
  }
});

test('the installed DSH parser accepts the extended manifest and preserves every plugin', async () => {
  const source = await readFile(new URL('../.runtime/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js', import.meta.url), 'utf8');
  let factory: ((require: (id: string) => never) => { parseBootManifest(value: unknown): { modules: { id: string }[]; plugins: { id: string }[] } }) | undefined;
  runInNewContext(source, { window: { __ModuleLoader__: { load(registration: { factory: typeof factory }) { factory = registration.factory; } } } }, { timeout: 1000 });
  assert.ok(factory);
  const upstream = factory((id: string) => { throw new Error(`Unexpected dependency in DSH manifest parser: ${id}`); });
  const graph = withDesktopPlugin(fixture(), 'desktop.1');
  const parsed = upstream.parseBootManifest(graph);
  assert.deepEqual(Array.from(parsed.modules, (entry) => entry.id), graph.entries.map((entry) => entry.id));
  assert.deepEqual(Array.from(parsed.plugins, (entry) => entry.id), graph.entries.map((entry) => entry.id));
});
