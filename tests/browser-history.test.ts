import test from 'node:test';
import assert from 'node:assert/strict';
import { browserHistory } from '../src/main/browser-history.ts';

function history() {
  return {
    index: 1,
    canGoBack() { return this.index > 0; },
    canGoForward() { return this.index < 1; },
    goBack() { this.index--; },
    goForward() { this.index++; },
  };
}

test('Electron 31 uses WebContents navigation even when navigationHistory exists', () => {
  const legacy = { ...history(), navigationHistory: { getActiveIndex: () => 1 } };
  const controls = browserHistory(legacy as unknown as Parameters<typeof browserHistory>[0]);
  assert.equal(controls, legacy);
  assert.equal(controls.canGoBack(), true);
  controls.goBack();
  assert.equal(controls.canGoBack(), false);
  assert.equal(controls.canGoForward(), true);
  controls.goForward();
  assert.equal(legacy.index, 1);
});

test('modern Electron keeps its navigationHistory receiver and avoids deprecated methods', () => {
  const modern = history();
  const controls = browserHistory({ navigationHistory: modern, canGoBack() { throw new Error('Legacy method used'); } });
  assert.equal(controls, modern);
  controls.goBack();
  assert.equal(controls.canGoForward(), true);
  controls.goForward();
  assert.equal(controls.canGoBack(), true);
});

test('unsupported runtimes fail before attaching navigation event handlers', () => {
  assert.throws(() => browserHistory({ navigationHistory: {} }), /不支持页面导航/);
});
