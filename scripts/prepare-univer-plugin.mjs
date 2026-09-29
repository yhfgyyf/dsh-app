// Repackage a pinned upstream plugin. Never reads or modifies a DSH profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const patchDir = join(project, 'patches/univer-office-0.3.5-dsh-rc1');
const manifest = JSON.parse(await readFile(join(patchDir, 'manifest.json'), 'utf8'));
const alignmentBytes = await readFile(join(patchDir, manifest.alignmentPatch.file));
assert.equal(createHash('sha256').update(alignmentBytes).digest('hex'), manifest.alignmentPatch.sha256, 'Modified alignment patch record');
const alignment = JSON.parse(alignmentBytes);
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--archive', '--out', '--npm-cli'].includes(args[i]) && args[i + 1], 'Usage: node scripts/prepare-univer-plugin.mjs --out DIRECTORY [--archive upstream.tgz] [--npm-cli npm-cli.js]');
  options[args[i].slice(2)] = resolve(args[i + 1]);
}
assert.ok(options.out, '--out must be an isolated output directory');
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const exists = async (path) => access(path).then(() => true, () => false);
function run(command, argv, cwd) {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}
async function npmCli() {
  const candidates = [options['npm-cli'], process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const command = join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!await exists(command)) continue;
    const target = await realpath(command);
    if (target.endsWith('npm-cli.js')) candidates.push(target);
    candidates.push(join(dirname(target), 'node_modules/npm/bin/npm-cli.js'));
  }
  for (const path of candidates) if (path.endsWith('npm-cli.js') && await exists(path)) return path;
  throw new Error('Cannot locate npm-cli.js; supply --npm-cli with the npm shipped with your build Node.js');
}
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(directory, path));
    else {
      assert.ok(entry.isFile(), `Unexpected non-file: ${path}`);
      result.push({ path, sha256: hash(await readFile(join(directory, path))) });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one patch target: ${before}`);
  return source.replace(before, after);
}
await mkdir(options.out, { recursive: true });
const temporary = await mkdtemp(join(options.out, '.prepare-'));
try {
  const archive = options.archive ?? join(temporary, 'upstream.tgz');
  if (!options.archive) {
    const response = await fetch(manifest.upstream.url, { signal: AbortSignal.timeout(180_000) });
    assert.ok(response.ok, `Upstream download failed: HTTP ${response.status}`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  const upstream = await readFile(archive);
  assert.equal(upstream.length, manifest.upstream.bytes, 'Unexpected upstream archive size');
  assert.equal(hash(upstream), manifest.upstream.sha256, 'Unknown upstream archive; refusing to patch');
  const listing = run('tar', ['-tzf', archive], temporary).trim().split(/\r?\n/);
  assert.ok(listing.every((path) => path.startsWith('package/') && !path.includes('\\') && !path.split('/').includes('..')), 'Unsafe archive path');
  run('tar', ['-xzf', archive, '-C', temporary], temporary);
  const packageDir = join(temporary, 'package');
  const beforeFiles = await files(packageDir);
  for (const entry of manifest.files) {
    assert.equal(hash(await readFile(join(patchDir, entry.patch))), entry.patchSha256, `Modified patch record: ${entry.patch}`);
    const path = join(packageDir, entry.path);
    const original = await readFile(path, 'utf8');
    assert.equal(hash(original), entry.before, `Unexpected baseline: ${entry.path}`);
    let patched;
    if (entry.path === 'package.json') {
      const value = JSON.parse(original);
      assert.equal(value.version, manifest.upstreamVersion);
      value.version = manifest.version;
      for (const name of Object.keys(value.peerDependencies)) {
        if (name.startsWith('@deepseek-ai/dsh-')) value.peerDependencies[name] += ` || ${manifest.dsh}`;
      }
      patched = JSON.stringify(value, null, 2) + '\n';
    } else if (entry.path === 'lib/index.js') {
      patched = replaceOnce(original, 'telemetry: z.boolean().default(true)', 'telemetry: z.boolean().default(false)');
      patched = replaceOnce(patched, 'telemetry: config.telemetry ?? true', 'telemetry: config.telemetry ?? false');
    } else if (entry.path === 'lib/client.js') {
      patched = replaceOnce(original, '      apply: () => apply,\n      inject: () => inject', '      apply: () => apply,\n      inject: () => inject,\n      name: () => "dsh-univer-office"');
    } else if (entry.path === 'artifacts/unit-content-worker.mjs') patched = original;
    else throw new Error(`Unsupported patch target: ${entry.path}`);
    for (const replacement of alignment[entry.path] ?? []) {
      assert.equal(patched.split(replacement.before).length - 1, replacement.count, `Unexpected alignment baseline: ${entry.path}`);
      patched = patched.replaceAll(replacement.before, replacement.after);
    }
    assert.equal(hash(patched), entry.after, `Patch output mismatch: ${entry.path}`);
    await writeFile(path, patched);
  }
  const afterFiles = await files(packageDir);
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry.after]));
  assert.equal(afterFiles.length, beforeFiles.length);
  for (let i = 0; i < beforeFiles.length; i++) {
    assert.equal(afterFiles[i].path, beforeFiles[i].path);
    assert.equal(afterFiles[i].sha256, expected.get(beforeFiles[i].path) ?? beforeFiles[i].sha256);
  }
  const [packed] = JSON.parse(run(process.execPath, [await npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], packageDir));
  assert.equal(packed.version, manifest.version);
  const archiveBytes = await readFile(join(temporary, packed.filename));
  const archiveHash = hash(archiveBytes);
  const output = join(options.out, packed.filename);
  if (await exists(output)) assert.equal(hash(await readFile(output)), archiveHash, 'Existing output differs; choose a new output directory');
  else await copyFile(join(temporary, packed.filename), output);
  const report = { status: 'pass', package: manifest.package, version: manifest.version, dsh: manifest.dsh, upstream: manifest.upstream,
    output, bytes: archiveBytes.length, sha256: archiveHash, changedFiles: manifest.files.map(({ path, before, after }) => ({ path, before, after })), files: afterFiles };
  await writeFile(join(options.out, 'univer-plugin-provenance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output, bytes: report.bytes, sha256: report.sha256, files: afterFiles.length }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
