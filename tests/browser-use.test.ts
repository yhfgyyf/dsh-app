import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserCandidates, browserProfileRoot, DesktopBrowserUse } from '../src/main/browser-use.ts';
import { createBrowserUseController } from '../src/runtime/browser-use.ts';
import { defaultPreferences, parsePreferences } from '../src/shared/config.ts';

const extensionFixture = { async findPlaywrightExtensionProfile() { return 'Default'; }, playwrightExtensionInstallUrl: 'https://example.invalid/playwright-extension' };

test('Browser Use stays off for existing preferences and rejects invalid switch values', () => {
  const old: any = defaultPreferences();
  delete old.browserUseEnabled;
  assert.equal(parsePreferences(old).browserUseEnabled, false);
  assert.equal(parsePreferences({ ...old, browserUseEnabled: true }).browserUseEnabled, true);
  assert.throws(() => parsePreferences({ ...old, browserUseEnabled: 'true' }));
});

test('finds supported Mac and Windows browsers without relying on the host path format', () => {
  assert.equal(browserCandidates('darwin', '/Users/test', {})[0].path, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.deepEqual(browserCandidates('win32', '', { PROGRAMFILES: 'C:\\Program Files' })[0], { name: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  assert.equal(browserProfileRoot('Google Chrome', 'darwin', '/Users/test', {}), '/Users/test/Library/Application Support/Google/Chrome');
  assert.equal(browserProfileRoot('Microsoft Edge', 'win32', 'C:\\Users\\test', {}), 'C:\\Users\\test\\AppData\\Local\\Microsoft\\Edge\\User Data');
  assert.deepEqual(browserCandidates('linux', '/home/test', {}), []);
});

test('enable and disable are serialized and missing browsers leave tools off', async () => {
  const operations: boolean[] = [];
  const control = new DesktopBrowserUse(async config => { operations.push(config.enabled); }, () => {}, async () => ({ name: 'Chrome', path: '/browser', userDataDir: '/profile' }));
  await Promise.all([control.setEnabled(true), control.setEnabled(false)]);
  assert.deepEqual(operations, [true, false]);
  assert.equal(control.state.enabled, false);
  assert.equal(control.state.phase, 'disabled');
  const missing = new DesktopBrowserUse(async () => { throw new Error('must not configure'); }, () => {}, async () => { throw new Error('missing browser'); });
  assert.equal((await missing.setEnabled(true)).enabled, false);
  assert.equal(missing.state.error, 'missing browser');
});

test('existing browser login uses extension-owned tab groups without isolated profiles or approval bypass', async () => {
  const previous = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'untrusted-inherited-test-value';
  const calls: any[] = [];
  const scope = { on() {} };
  const ctx = { get: () => ({}), async plugin(plugin: any) { plugin.apply(scope); return { dispose: async () => {} }; } };
  try {
    const control = await createBrowserUseController(ctx, async id => {
      assert.equal(id, '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp');
      return { mountSessionMcp(target: any, options: any) { assert.equal(target, scope); calls.push(options); } };
    }, '/runtime/playwright/cli.js', extensionFixture);
    await control.configure({ enabled: true, executablePath: '/browser', userDataDir: '/existing-profile' });
    assert.deepEqual(calls[0].args, ['/runtime/playwright/cli.js', '--browser', 'chrome', '--extension', '--executable-path', '/browser', '--user-data-dir', '/existing-profile']);
    assert.equal(calls[0].exclusive, false);
    assert.equal(calls[0].env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, '');
    await control.configure({ enabled: false });
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = previous;
  }
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

test('only a saved extension token reaches MCP, through env rather than arguments', async () => {
  const calls: any[] = [];
  const ctx = { get: () => ({}), async plugin(plugin: any) { plugin.apply({ on() {} }); return { dispose: async () => {} }; } };
  const control = await createBrowserUseController(ctx, async () => ({ mountSessionMcp(_ctx: any, options: any) { calls.push(options); } }), '/cli.js', extensionFixture);
  const token = 'fixture-explicit-extension-token';
  await control.configure({ enabled: true, executablePath: '/browser', userDataDir: '/profile', extensionToken: token });
  assert.equal(calls[0].env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, token);
  assert.ok(!calls[0].args.some((arg: string) => arg.includes(token)));
  await control.configure({ enabled: false });
});

test('a missing extension never starts a handshake and installation is rechecked on the next call', async () => {
  const require = createRequire(new URL('../.runtime/package.json', import.meta.url));
  const extension = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib/tools/utils/extension.js'));
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-extension-profile-'));
  let guard: any, forwarded = 0;
  const scope = { on(event: string, handler: any) { assert.equal(event, 'tools/execute'); guard = handler; } };
  const ctx = { get: () => ({}), async plugin(plugin: any) { plugin.apply(scope); return { dispose: async () => {} }; } };
  const control = await createBrowserUseController(ctx, async () => ({ mountSessionMcp() {} }), '/cli.js', extension);
  const next = async () => { forwarded++; return 'forwarded'; };
  try {
    await mkdir(join(userDataDir, 'Default'));
    await control.configure({ enabled: true, executablePath: '/browser', userDataDir });
    assert.equal(typeof guard, 'function');
    await assert.rejects(guard({ name: 'mcp__playwright-mcp__browser_tabs' }, next), /安装.*Playwright Extension/);
    await assert.rejects(guard({ name: 'mcp__playwright-mcp__browser_navigate' }, next), /安装.*Playwright Extension/);
    assert.equal(forwarded, 0, 'No failed handshake may be cached while the extension is missing');
    assert.equal(await guard({ name: 'read' }, next), 'forwarded', 'Other tools remain available');
    // Reuse the pinned upstream probe, including non-default profiles and unpacked installs.
    await mkdir(join(userDataDir, 'Profile 1'));
    await writeFile(join(userDataDir, 'Profile 1', 'Secure Preferences'), JSON.stringify({ extensions: { settings: { [extension.playwrightExtensionId]: { state: 1 } } } }));
    assert.equal(await guard({ name: 'mcp__playwright-mcp__browser_tabs' }, next), 'forwarded');
    assert.equal(forwarded, 2, 'Installing the extension permits a fresh first handshake without recreating the provider');
    await rm(join(userDataDir, 'Profile 1'), { recursive: true });
    await assert.rejects(guard({ name: 'mcp__playwright-mcp__browser_tabs' }, next), /安装.*Playwright Extension/);
    assert.equal(forwarded, 2, 'Removing the extension is detected again');
  } finally {
    await control.configure({ enabled: false });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('saving a credential preserves the active session, applies after restart, and never returns plaintext', async () => {
  let stored: string | undefined;
  const credentials = { async load() { return stored; }, async save(value: string | undefined) { stored = value; } };
  const calls: any[] = [], published: any[] = [];
  const create = () => new DesktopBrowserUse(async config => { calls.push(config); }, state => published.push(state), async () => ({ name: 'Chrome', path: '/browser', userDataDir: '/profile' }), credentials);
  const initial = create();
  await initial.restoreCredentials();
  await initial.setEnabled(true);
  const token = 'fixture-persisted-extension-token';
  const saved = await initial.saveExtensionToken('PLAYWRIGHT_MCP_EXTENSION_TOKEN=' + token);
  assert.equal(saved.extensionTokenConfigured, true);
  assert.equal(saved.restartRequired, true);
  assert.equal(calls.length, 1, 'Saving must not replace an active MCP session');
  const restored = create();
  await restored.restoreCredentials();
  assert.equal(restored.state.restartRequired, false);
  await restored.setEnabled(true);
  assert.equal(calls[1].extensionToken, token);
  const cleared = await restored.saveExtensionToken(null);
  assert.equal(cleared.extensionTokenConfigured, false);
  assert.equal(cleared.restartRequired, true);
  assert.ok(!JSON.stringify(published).includes(token));
  const manual = create();
  await manual.restoreCredentials();
  await manual.setEnabled(true);
  assert.equal(calls[2].extensionToken, undefined);
});

test('credential decryption failure is visible without granting automatic browser access', async () => {
  const calls: any[] = [];
  const control = new DesktopBrowserUse(async config => { calls.push(config); }, () => {}, async () => ({ name: 'Chrome', path: '/browser', userDataDir: '/profile' }), { async load() { throw new Error('Unable to decrypt'); }, async save() { throw new Error('Unable to save'); } });
  await control.restoreCredentials();
  await control.setEnabled(true);
  assert.equal(control.state.credentialError, 'Unable to decrypt');
  assert.equal(calls[0].extensionToken, undefined);
  await assert.rejects(control.saveExtensionToken('fixture-not-saved-token'), /Unable to save/);
  assert.notEqual(control.state.extensionTokenConfigured, true);
});
