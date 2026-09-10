import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeNodeModules = process.env.DSH_OVERLAY_TEST_RUNTIME ?? fileURLToPath(new URL('../.runtime/node_modules', import.meta.url));
const clientNodeModules = process.env.DSH_OVERLAY_TEST_CLIENT ?? fileURLToPath(new URL('../node_modules', import.meta.url));
const paths = await import(pathToFileURL(join(runtimeNodeModules, '@deepseek-ai/dsh-util-workspace-path/lib/index.js')).href);
const source = await readFile(join(runtimeNodeModules, '@deepseek-ai/dsh-client-ui-chat/lib/client.js'), 'utf8');
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
  assert.deepEqual(await applyArtifactLinks({ runtimeNodeModules, clientNodeModules, mode: 'check' }), { pending: 0 });
  assert.deepEqual(await applyArtifactLinks({ runtimeNodeModules, clientNodeModules }), { changed: 0, verified: true });
});

test('first artifact adapter installation keeps verified relative backup paths on every platform', async () => {
  const { applyArtifactLinks } = await import(new URL('../scripts/install-artifact-links.mjs', import.meta.url).href);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-artifact-backup-')));
  const { version } = JSON.parse(await readFile(join(runtimeNodeModules, '@deepseek-ai/dsh-client-ui-chat/package.json'), 'utf8'));
  const patchRoot = join(root, 'patches', `dsh-${version}`, 'artifact-links');
  const manifest = JSON.parse(await readFile(join(patchRoot, 'manifest.json'), 'utf8'));
  for (const file of manifest.files) {
    const base = join(scratch, file.kind === 'primitives' ? 'primitives' : 'runtime');
    const target = join(base, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(join(base, file.package, 'package.json'), JSON.stringify({ name: file.package, version: manifest.dsh }));
    await writeFile(target, await readFile(join(file.kind === 'primitives' ? clientNodeModules : runtimeNodeModules, file.path)));
    const reverted = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--reverse', '--unsafe-paths', '--directory=' + base.replaceAll('\\', '/'), join(patchRoot, file.kind + '.patch')], { cwd: scratch, encoding: 'utf8' });
    assert.equal(reverted.status, 0, reverted.stderr);
  }
  const options = { runtimeNodeModules: join(scratch, 'runtime'), clientNodeModules: join(scratch, 'primitives'), backupHome: join(scratch, 'backup') };
  const result = await applyArtifactLinks(options);
  assert.equal(result.changed, manifest.files.length);
  for (const file of manifest.files) {
    const bytes = await readFile(join(result.backup, file.kind, file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.before);
  }
  assert.deepEqual(await applyArtifactLinks({ ...options, mode: 'check' }), { pending: 0 });
  assert.deepEqual(await applyArtifactLinks({ ...options, mode: 'verify' }), { changed: 0, verified: true });
  assert.deepEqual(await applyArtifactLinks(options), { changed: 0, verified: true });
  const first = manifest.files[0];
  const firstPath = join(scratch, first.kind === 'primitives' ? 'primitives' : 'runtime', first.path);
  await writeFile(firstPath, await readFile(join(result.backup, first.kind, first.path)));
  const last = manifest.files.at(-1);
  const lastPath = join(scratch, last.kind === 'primitives' ? 'primitives' : 'runtime', last.path);
  const unknown = (await readFile(lastPath, 'utf8')) + '\n// unknown local change\n';
  await writeFile(lastPath, unknown);
  await assert.rejects(applyArtifactLinks(options), /Unrecognized changes preserved/);
  assert.equal(createHash('sha256').update(await readFile(firstPath)).digest('hex'), first.before, 'Preflight rejects an unknown later target before writing an earlier pending target');
  assert.equal(await readFile(lastPath, 'utf8'), unknown);
});
