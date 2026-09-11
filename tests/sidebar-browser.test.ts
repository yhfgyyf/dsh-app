import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserBounds, previewFileOf, validBrowserId, webAddress, webUrlOf } from '../src/shared/sidebar-browser.ts';
import { previewGrant } from '../src/main/preview-files.ts';

test('sidebar links retain query and fragment while rejecting executable URLs and credentials', () => {
  const url = 'https://example.com/三体?q=a&b=2#page';
  assert.equal(webUrlOf(webAddress(url)), new URL(url).href);
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.com/']) assert.throws(() => webAddress(value));
  assert.equal(webUrlOf('dsh-resource://web/%ZZ'), undefined);
  assert.equal(validBrowserId('session-a:tab-2'), true);
  assert.equal(validBrowserId('../tab'), false);
});

test('browser bounds respect zoom, clip to the host window, and hide invalid views', () => {
  assert.deepEqual(browserBounds({ x: 50, y: 40, width: 400, height: 200 }, 1.5, { width: 600, height: 300 }), { x: 75, y: 60, width: 525, height: 240 });
  for (const value of [null, {}, { x: NaN, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 0, height: 10 }]) assert.equal(browserBounds(value, 1, { width: 600, height: 400 }), undefined);
});

test('file addresses bind session paths to the current session', () => {
  assert.deepEqual(previewFileOf('dsh-resource://file/session/s1/图表.html', 's1'), { path: '图表.html', relative: true });
  assert.deepEqual(previewFileOf('dsh-resource://file/absolute/tmp/chart.html', 's1'), { path: '/tmp/chart.html', relative: false });
  assert.equal(previewFileOf('dsh-resource://file/session/s2/chart.html', 's1'), undefined);
  assert.equal(previewFileOf('dsh-resource://file/session/s1/%2E%2E%2Fsecret.html', 's1'), undefined);
  assert.equal(previewFileOf('dsh-resource://file/session/s1/%2Ftmp/secret.html', 's1'), undefined);
  assert.deepEqual(previewFileOf('dsh-resource://file/session/s1/C:/secret.html', 's1'), { path: 'C:/secret.html', relative: false });
});

test('file previews accept session-owned absolute paths without accepting traversal or encoded separators', () => {
  for (const [address, path] of [
    ['dsh-resource://file/session/s1/C:/Users/name/%E6%8A%A5%20%E5%91%8A.txt', 'C:/Users/name/报 告.txt'],
    ['dsh-resource://file/absolute/c:/Users/name/report.txt', 'c:/Users/name/report.txt'],
    ['dsh-resource://file/session/s1//tmp/report.txt', '/tmp/report.txt'],
    ['dsh-resource://file/session/s1///server/share/report.txt', '//server/share/report.txt'],
    ['dsh-resource://file/absolute//server/share/report.txt', '//server/share/report.txt'],
  ]) assert.deepEqual(previewFileOf(address, 's1'), { path, relative: false });
  for (const address of [
    'dsh-resource://file/session/s2/C:/report.txt',
    'dsh-resource://file/session/s1/../secret.txt',
    'dsh-resource://file/session/s1/folder/../secret.txt',
    'dsh-resource://file/session/s1/folder/%2e%2e/secret.txt',
    'dsh-resource://file/session/s1/folder%2Fsecret.txt',
    'dsh-resource://file/session/s1/folder%5Csecret.txt',
    'dsh-resource://file/session/s1/C:secret.txt',
    'dsh-resource://file/session/s1/report%00.txt',
  ]) assert.equal(previewFileOf(address, 's1'), undefined, address);
});

test('local preview serves HTML and web assets but prevents directory and symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-preview-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, '图 表.html'), '<canvas id="chart"></canvas>');
  await writeFile(join(workspace, 'chart.js'), 'document.title="Canvas"');
  await writeFile(join(workspace, '.private.json'), '{"secret":true}');
  await writeFile(join(root, 'outside.json'), '{}');
  await symlink(join(root, 'outside.json'), join(workspace, 'escape.json'));
  const grant = await previewGrant({ kind: 'preview', sessionId: 's1', cwd: workspace, address: 'dsh-resource://file/session/s1/' + encodeURIComponent('图 表.html') });
  const document = await grant.read(new Request(grant.url));
  assert.equal(document.status, 200);
  assert.equal(await document.text(), '<canvas id="chart"></canvas>');
  assert.match(document.headers.get('content-type')!, /text\/html/);
  assert.equal((await grant.read(new Request(new URL('chart.js', grant.url)))).status, 200);
  for (const path of ['.private.json', 'escape.json', '%2E%2E%2Foutside.json', '%2Fetc%2Fpasswd']) assert.equal((await grant.read(new Request(new URL(path, grant.url)))).status, 403, path);
  assert.equal((await grant.read(new Request(grant.url, { method: 'POST' }))).status, 404);
  assert.equal((await grant.read(new Request(grant.url.replace(grant.host, 'other')))).status, 404);
});

test('an explicitly opened file outside the workspace retains its session and grants its own directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-outside-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const path = join(root, 'outside.html');
  await writeFile(path, '<p>Outside workspace</p>');
  const address = 'dsh-resource://file/session/s1/' + path.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');
  const grant = await previewGrant({ kind: 'preview', sessionId: 's1', cwd: workspace, address });
  assert.equal(await (await grant.read(new Request(grant.url))).text(), '<p>Outside workspace</p>');
  await assert.rejects(previewGrant({ kind: 'preview', sessionId: 's2', cwd: workspace, address }), /无法定位/);
});
