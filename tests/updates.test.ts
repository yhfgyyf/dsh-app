import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { compareVersions, RELEASES_URL, localDay, nextDailyCheck, selectUpdate, validateUpdateSchedule } from '../src/shared/updates.ts';
import { downloadUpdate, githubFetch } from '../src/main/update-download.ts';
import { DesktopUpdates } from '../src/main/updates.ts';

const bytes = new TextEncoder().encode('verified installer fixture');
const sha = createHash('sha256').update(bytes).digest('hex');
const makeUpdater = (home: string, fetch = async () => Response.json([])) => new DesktopUpdates({ currentVersion: '0.1.1', platform: 'win32', arch: 'x64', home, appPath: home, runtimeRoot: home, executable: join(home, 'DSH Desktop.exe'), packaged: true, corePid: () => undefined, quit: () => {}, publish: () => {}, fetch });

test('daily checks use local time and do not run twice on the same day', () => {
  const now = new Date(2026, 8, 9, 8, 30);
  assert.equal(nextDailyCheck(now, '09:00').getTime(), new Date(2026, 8, 9, 9).getTime());
  assert.equal(nextDailyCheck(now, '09:00', localDay(now)).getTime(), new Date(2026, 8, 10, 9).getTime());
  assert.equal(nextDailyCheck(new Date(2026, 8, 9, 10), '09:00').getTime(), new Date(2026, 8, 10, 9).getTime());
  for (const value of [{ mode: 'hourly', time: '09:00' }, { mode: 'daily', time: '24:00' }, { mode: 'daily', time: '9:00' }, null]) assert.throws(() => validateUpdateSchedule(value));
});

test('the latest selected schedule survives concurrent writes and app restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-update-preferences-'));
  const updater = makeUpdater(home);
  assert.deepEqual(updater.state.schedule, { mode: 'startup', time: '09:00' });
  await Promise.all([updater.setSchedule({ mode: 'daily', time: '13:25' }), updater.setSchedule({ mode: 'startup', time: '14:30' }), updater.setSchedule({ mode: 'daily', time: '18:45' })]);
  const restarted = makeUpdater(home);
  await restarted.restoreResult();
  assert.deepEqual(restarted.state.schedule, { mode: 'daily', time: '18:45' });
  await assert.rejects(restarted.setSchedule({ mode: 'daily', time: '25:00' }));
  assert.deepEqual(restarted.state.schedule, updater.state.schedule);
});

test('startup checks once per launch and daily mode waits for its configured time', async context => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-update-clock-'));
  let calls = 0;
  const updater = makeUpdater(home, async () => { calls++; return Response.json([]); });
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 8, 9, 8, 59, 30) });
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    updater.start(); updater.start();
    context.mock.timers.tick(14999); await flush(); assert.equal(calls, 0);
    context.mock.timers.tick(1); await flush(); assert.equal(calls, 1);
    await updater.setSchedule({ mode: 'daily', time: '09:00' });
    context.mock.timers.tick(14999); await flush(); assert.equal(calls, 1);
    context.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
    context.mock.timers.tick(60 * 60 * 1000); await flush(); assert.equal(calls, 2);
    await updater.setSchedule({ mode: 'startup', time: '09:00' });
    context.mock.timers.tick(24 * 60 * 60 * 1000); await flush(); assert.equal(calls, 2);
  } finally { updater.stop(); context.mock.timers.reset(); }
});
function release(version = '0.1.2', suffix = 'macOS-arm64.zip') {
  const name = `DSH-Desktop-${version}-${suffix}`;
  return { tag_name: 'v' + version, draft: false, prerelease: true, published_at: '2026-09-09T00:00:00Z', assets: [{ name, state: 'uploaded', digest: 'sha256:' + sha, size: bytes.length, browser_download_url: `https://github.com/yhfgyyf/dsh-app/releases/download/v${version}/${name}` }] };
}

test('version ordering handles numeric versions, previews, stable releases and downgrades', () => {
  for (const [a, b] of [['0.1.10', '0.1.9'], ['1.0.0', '1.0.0-rc.9'], ['1.0.0-rc.10', '1.0.0-rc.2'], ['1.0.0-beta', '1.0.0-alpha'], ['1.0.0-alpha.1', '1.0.0-alpha']]) {
    assert.equal(compareVersions(a, b), 1); assert.equal(compareVersions(b, a), -1);
  }
  assert.equal(compareVersions('v0.1.2+build.9', '0.1.2'), 0);
  assert.throws(() => compareVersions('latest', '0.1.2'));
});

test('published previews are selected by version and platform, excluding drafts and missing packages', () => {
  const versions = [release('0.1.9'), release('0.1.10'), {...release('9.0.0'), draft: true}, release('0.2.0', 'Windows-x64-Setup.exe')];
  assert.equal(selectUpdate(versions, '0.1.1', 'darwin', 'arm64')?.version, '0.1.10');
  assert.equal(selectUpdate(versions, '0.1.1', 'win32', 'x64')?.version, '0.2.0');
  assert.equal(selectUpdate(versions, '0.3.0', 'darwin', 'arm64'), undefined);
  assert.throws(() => selectUpdate(versions, '0.1.1', 'linux', 'x64'));
});

test('release assets must have the expected repository URL, size and SHA-256', () => {
  for (const mutate of [
    (value: ReturnType<typeof release>) => { value.assets[0].browser_download_url = 'https://example.com/setup.exe'; },
    (value: ReturnType<typeof release>) => { value.assets[0].digest = ''; },
    (value: ReturnType<typeof release>) => { value.assets[0].size = 2 ** 32; },
  ]) { const value = release(); mutate(value); assert.throws(() => selectUpdate([value], '0.1.1', 'darwin', 'arm64')); }
});

test('downloads follow GitHub CDN redirects and verify the complete streamed archive', async () => {
  const target = selectUpdate([release()], '0.1.1', 'darwin', 'arm64')!;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-download-'));
  const paths: string[] = [];
  const progress: number[] = [];
  await downloadUpdate(target, join(directory, target.name), async (input, options) => {
    const url = String(input); paths.push(url);
    assert.equal(options?.credentials, 'omit');
    return paths.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } }) : new Response(bytes);
  }, value => progress.push(value));
  assert.equal(paths.length, 2);
  assert.deepEqual(await readFile(join(directory, target.name)), Buffer.from(bytes));
  assert.equal(progress.at(-1), 100);
  assert.deepEqual(await readdir(directory), [target.name]);
});

test('a corrupt or truncated download never becomes an installable file; unsafe redirects are rejected', async () => {
  const target = selectUpdate([release()], '0.1.1', 'darwin', 'arm64')!;
  for (const body of [new Uint8Array(bytes.length), bytes.slice(1), new Uint8Array(bytes.length + 1)]) {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-update-corrupt-'));
    await assert.rejects(downloadUpdate(target, join(directory, target.name), async () => new Response(body), () => {}));
    assert.deepEqual(await readdir(directory), []);
  }
  await assert.rejects(githubFetch(target.assetUrl, async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }), AbortSignal.timeout(1000)), /不属于 GitHub/);
});

test('update service deduplicates requests, reports errors, retries and only installs packaged apps', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-update-service-'));
  let calls = 0, corrupt = true;
  const states: string[] = [];
  const updater = new DesktopUpdates({ currentVersion: '0.1.1', platform: 'win32', arch: 'x64', home, appPath: home, runtimeRoot: home, executable: join(home, 'DSH Desktop.exe'), packaged: false, corePid: () => undefined, quit: () => { throw new Error('Unexpected quit'); }, publish: state => states.push(state.status), fetch: async input => {
    calls++;
    if (String(input) === RELEASES_URL) return Response.json([release('0.1.2', 'Windows-x64-Setup.exe')]);
    return new Response(corrupt ? bytes.slice(1) : bytes);
  } });
  const [a, b] = await Promise.all([updater.check(), updater.check()]);
  assert.equal(calls, 1); assert.equal(a.status, 'available'); assert.equal(b.version, '0.1.2');
  assert.equal((await updater.download()).status, 'error');
  corrupt = false;
  assert.equal((await updater.download()).status, 'ready');
  assert.equal((await updater.install()).status, 'error');
  assert.match(updater.state.error!, /已安装/);
  assert.equal(updater.state.retry, 'install');
  await updater.setSchedule({ mode: 'daily', time: '09:00' });
  assert.match(updater.state.error!, /已安装/);
  assert.equal(updater.state.retry, 'install');
  const downloadedCalls = calls;
  assert.equal((await updater.check()).status, 'error');
  assert.equal((await updater.download()).status, 'ready');
  assert.equal(calls, downloadedCalls, 'An installation error must not download the same verified package again');
  assert.ok(states.includes('downloading') && states.includes('ready'));
});

test('network failures identify the GitHub host and code without exposing URL parameters or nested secrets', async () => {
  await assert.rejects(githubFetch('https://release-assets.githubusercontent.com/asset?secret=private', async () => {
    throw new TypeError('fetch failed secret=private', { cause: { code: 'ECONNREFUSED', token: 'private' } });
  }, AbortSignal.timeout(1000)), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /release-assets.githubusercontent.com.*ECONNREFUSED/);
    assert.doesNotMatch(error.message, /private|secret|token/);
    return true;
  });
});
