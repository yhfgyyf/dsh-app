import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCandidates, DesktopBrowserUse } from '../src/main/browser-use.ts';
import { createBrowserUseController } from '../src/runtime/browser-use.ts';
import { defaultPreferences, parsePreferences } from '../src/shared/config.ts';

test('Browser Use stays off for existing preferences and rejects invalid switch values', () => {
  const old: any = defaultPreferences();
  delete old.browserUseEnabled;
  assert.equal(parsePreferences(old).browserUseEnabled, false);
  assert.equal(parsePreferences({ ...old, browserUseEnabled: true }).browserUseEnabled, true);
  assert.throws(() => parsePreferences({ ...old, browserUseEnabled: 'true' }));
});

test('finds supported Mac and Windows browsers without relying on the host path format', () => {
  assert.equal(browserCandidates('darwin', '/Users/test', {})[0].path, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.deepEqual(browserCandidates('win32', '', { PROGRAMFILES: 'C:\\Program Files' })[0], { name: 'Microsoft Edge', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' });
  assert.deepEqual(browserCandidates('linux', '/home/test', {}), []);
});

test('enable and disable are serialized and missing browsers leave tools off', async () => {
  const operations: boolean[] = [];
  const control = new DesktopBrowserUse(async config => { operations.push(config.enabled); }, () => {}, async () => ({ name: 'Chrome', path: '/browser' }));
  await Promise.all([control.setEnabled(true), control.setEnabled(false)]);
  assert.deepEqual(operations, [true, false]);
  assert.deepEqual(control.state, { enabled: false, phase: 'disabled' });
  const missing = new DesktopBrowserUse(async () => { throw new Error('must not configure'); }, () => {}, async () => { throw new Error('missing browser'); });
  assert.equal((await missing.setEnabled(true)).enabled, false);
  assert.equal(missing.state.error, 'missing browser');
});

test('the provider is opt-in, uses the selected browser, and disposal completes before re-enabling', async () => {
  const events: string[] = [];
  const ctx = {
    get: () => ({}),
    async plugin(module: string, config: any) {
      assert.match(module, /playwright-mcp$/);
      assert.deepEqual(config, { mode: 'launch', headless: false, executablePath: '/browser' });
      events.push('enable');
      return { async dispose() { events.push('disable'); } };
    },
  };
  const control = await createBrowserUseController(ctx, async id => id);
  assert.deepEqual(events, []);
  await control.configure({ enabled: true, executablePath: '/browser' });
  await Promise.all([control.configure({ enabled: false }), control.configure({ enabled: true, executablePath: '/browser' })]);
  assert.deepEqual(events, ['enable', 'disable', 'enable']);
});
