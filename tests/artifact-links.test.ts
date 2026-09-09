import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireRuntime = createRequire(new URL('../.runtime/package.json', import.meta.url));
const paths = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-util-workspace-path')).href);
const source = await readFile(new URL('../.runtime/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('function localArtifactPath(');
const end = source.indexOf('/** Reasoning block', start);
assert.ok(start > 0 && end > start, 'Install the artifact adapter before testing');
const { localArtifactPath, localPathMediaUrl } = new Function('isAbsoluteWorkspacePath', source.slice(start, end) + '; return {localArtifactPath, localPathMediaUrl};')(paths.isAbsoluteWorkspacePath);

test('artifact paths use the owning workspace and normalize relative, spaced and Windows destinations', () => {
  assert.equal(localArtifactPath('pelican-riding-bicycle.svg', '/Users/yang/Documents'), '/Users/yang/Documents/pelican-riding-bicycle.svg');
  assert.equal(localArtifactPath('/tmp/pelican-preview.png', '/other'), '/tmp/pelican-preview.png');
  assert.equal(localArtifactPath('docs/report.md', '/workspace'), '/workspace/docs/report.md');
  assert.equal(localArtifactPath('../outside.svg', '/workspace'), '/outside.svg');
  assert.equal(localArtifactPath('file:///tmp/my%20image.png', '/workspace'), '/tmp/my image.png');
  assert.equal(localArtifactPath('my image.png', '/workspace'), '/workspace/my image.png');
  assert.equal(localArtifactPath('report.md', 'C:\\Workspace'), 'C:/Workspace/report.md');
  assert.equal(localArtifactPath('C:\\Workspace\\plot.svg'), 'C:/Workspace/plot.svg');
});

test('web URLs, executable schemes, non-path code and unresolved relative paths remain inert', () => {
  for (const value of ['https://example.org/a.png', '//example.org/a.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file://remote/share.png', 'file:///tmp/a.png?download=1', 'viewBox', 'relative.svg\n', '/tmp/a\0.png', '~/unknown.png']) {
    assert.equal(localArtifactPath(value, '/workspace'), undefined, value);
  }
  assert.equal(localArtifactPath('plot.svg'), undefined);
});

test('Markdown image destinations resolve relative and encoded paths through the authenticated file endpoint', () => {
  assert.equal(localPathMediaUrl('http:', 'http://localhost:1234', 'charts/my%20plot.svg', '/workspace'), 'http://localhost:1234/api/file?path=%2Fworkspace%2Fcharts%2Fmy%20plot.svg');
  assert.equal(localPathMediaUrl('http:', 'http://localhost:1234', 'https://outside.invalid/a.png', '/workspace'), undefined);
  assert.equal(localPathMediaUrl('file:', 'null', '/tmp/a.png'), undefined);
});

test('artifact package adapter is idempotent and verifies both runtime and bundled renderer', async () => {
  const { applyArtifactLinks } = await import(new URL('../scripts/install-artifact-links.mjs', import.meta.url).href);
  assert.deepEqual(await applyArtifactLinks({ mode: 'check' }), { pending: 0 });
  assert.deepEqual(await applyArtifactLinks(), { changed: 0, verified: true });
});
