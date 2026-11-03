import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { DesktopRuntime } from '../src/main/runtime.ts';
import { desktopIndexInjections } from '../src/runtime/index-injections.ts';
import { assertDesktopBoot, type BootGraph, type IndexInjection } from '../src/shared/dsh-boot.ts';

const graph: BootGraph = {
  rev: 'fixture', entries: [{ id: 'core', url: '/core.js', rev: '1' }],
  batches: [{ url: '/core.js', rev: '1', phase: 'bootstrap', entries: ['core'] }],
};
const requireDsh = createRequire(new URL('../.runtime/package.json', import.meta.url));
const { bootInjections } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-client-modules')).href);

test('retains ordered plugin rows while excluding exactly the real core bootstrap protocol', () => {
  const core: IndexInjection[] = bootInjections(graph);
  const before: IndexInjection[] = [{ kind: 'global', name: '__DSH_BOOT_EXTRA__', value: { enabled: true } }];
  const after: IndexInjection[] = [
    { kind: 'script', placement: 'head', text: 'window.__ModuleLoader__.customPlugin = true' },
    { kind: 'script-src', placement: 'body', src: '/widget.js' },
    { kind: 'style', text: '.widget { color: blue }' },
  ];
  // Cloning/reordered keys must not make a native row run a second time.
  const rows = [...before, ...JSON.parse(JSON.stringify(core)).map((row: object) => Object.fromEntries(Object.entries(row).reverse())), ...after];
  const original = structuredClone(rows);
  assert.deepEqual(desktopIndexInjections(rows, core), [...before, ...after]);
  assert.deepEqual(rows, original);
  assert.ok(core.some(row => row.kind === 'script' && row.text.includes('__ModuleLoader__')));
  assert.ok(core.some(row => row.kind === 'script-src' && row.src === '/core.js'));
  assert.ok(core.some(row => row.kind === 'global' && row.name === '__DSH_BOOT__'));
});

test('rejects missing injection payloads and malformed module graphs', () => {
  for (const value of [null, graph, { graph }, { graph, injections: {} }, { graph: {}, injections: [] }]) {
    assert.throws(() => assertDesktopBoot(value));
  }
  assert.doesNotThrow(() => assertDesktopBoot({ graph, injections: [] }));
});

test('Desktop boot IPC carries fresh injection rows, preserves graph callers and forwards Host failures', async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { connected: true });
  let revision = 0, fail = false;
  child.send = ((message: { type: string; id: string }) => {
    assert.equal(message.type, 'get-boot');
    const result = fail ? { error: 'fixture injection failed' } : { graph, injections: [{ kind: 'global', name: 'fixtureRevision', value: ++revision }] };
    queueMicrotask(() => child.emit('message', { type: 'boot-result', id: message.id, ...result }));
    return true;
  }) as typeof child.send;
  const runtime = new DesktopRuntime({ runtimeRoot: '', entry: '', home: '', cwd: '', onExit() {} });
  runtime.child = child;
  runtime.ready = { type: 'ready', endpoint: '', launchUrl: '', graph, hostPlugins: [] };
  assert.deepEqual((await runtime.boot()).injections, [{ kind: 'global', name: 'fixtureRevision', value: 1 }]);
  assert.deepEqual((await runtime.boot()).injections, [{ kind: 'global', name: 'fixtureRevision', value: 2 }]);
  assert.deepEqual(await runtime.graph(), graph);
  fail = true;
  await assert.rejects(runtime.boot(), /fixture injection failed/);
  assert.equal(child.listenerCount('message'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});
