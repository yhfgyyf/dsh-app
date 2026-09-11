import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { localTargetPath } from '../src/main/local-path.ts';
import { currentLocalTarget } from '../src/shared/local-open.ts';

const cwd = resolve('workspace');
const sessionId = 'session-local-open';

test('local opening resolves the current session file, including spaces, Unicode and shell metacharacters', () => {
  for (const filename of ['report.md', 'my image.png', "结果 $(touch nope) ' ` &.txt"]) {
    const address = `dsh-resource://file/session/${sessionId}/${encodeURIComponent(filename)}`;
    const target = currentLocalTarget(address, sessionId, cwd);
    assert.equal(localTargetPath(target), join(cwd, filename));
  }
  const path = join(cwd, 'nested', 'report.pdf');
  assert.equal(localTargetPath({ path }), path);
  const normalized = path.replaceAll('\\', '/').replace(/^\//, '');
  const absolute = 'dsh-resource://file/absolute/' + normalized.split('/').map(encodeURIComponent).join('/');
  assert.equal(localTargetPath({ address: absolute, sessionId }), path);
});

test('web, terminal, foreign-session and malformed resources never become local launch targets', () => {
  for (const address of [undefined, 'https://example.com/a.txt', 'file:///tmp/a', 'dsh-resource://web/https%3A%2F%2Fexample.com', 'dsh-resource://terminal/default',
    'dsh-resource://file/session/other/report.md', `dsh-resource://file/session/${sessionId}/../secret`, `dsh-resource://file/session/${sessionId}/%00bad`, `dsh-resource://file/session/${sessionId}/C%3Arelative/test`]) {
    assert.equal(currentLocalTarget(address, sessionId, cwd), undefined);
  }
  for (const target of [undefined, { path: 'relative.md' }, { path: '\0bad' }, { address: `dsh-resource://file/session/${sessionId}/report.md`, sessionId }]) assert.throws(() => localTargetPath(target));
});

test('session-owned absolute files resolve outside the workspace only in the native path format', () => {
  const path = resolve(cwd, '..', 'outside.txt');
  const address = `dsh-resource://file/session/${sessionId}/` + path.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');
  assert.equal(localTargetPath(currentLocalTarget(address, sessionId, cwd)), path);
  const windows = `dsh-resource://file/session/${sessionId}/C%3A/Other/report.txt`;
  const target = currentLocalTarget(windows, sessionId, cwd);
  assert.deepEqual(target, { address: windows, sessionId, cwd });
  if (process.platform === 'win32') assert.equal(localTargetPath(target), 'C:\\Other\\report.txt');
  else assert.throws(() => localTargetPath(target), /无法定位/);
});
