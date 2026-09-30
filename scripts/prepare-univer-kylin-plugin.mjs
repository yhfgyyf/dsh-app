// Produce an explicitly limited Kylin preview without touching installed profiles.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const patches = join(root, 'patches/univer-office-kylin');
const manifest = JSON.parse(await readFile(join(patches, 'manifest.json'), 'utf8'));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  assert.ok(['--archive', '--out', '--npm-cli'].includes(name) && process.argv[i + 1]);
  options[name.slice(2)] = resolve(process.argv[i + 1]);
}
assert.ok(options.archive && options.out, 'Usage: node scripts/prepare-univer-kylin-plugin.mjs --archive dsh-univer-office-0.3.5-desktop.1.tgz --out DIRECTORY [--npm-cli npm-cli.js]');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => access(path).then(() => true, () => false);
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function inventory(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await inventory(directory, path));
    else {
      assert.ok(entry.isFile(), `Unexpected non-file: ${path}`);
      result.push({ path, sha256: hash(await readFile(join(directory, path))) });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
let npm = options['npm-cli'];
if (!npm) {
  for (const path of (process.env.PATH ?? '').split(delimiter)) {
    if (!await exists(join(path, 'npm'))) continue;
    const candidate = await realpath(join(path, 'npm'));
    if (candidate.endsWith('npm-cli.js')) { npm = candidate; break; }
  }
}
assert.ok(npm, 'Pass --npm-cli with the npm-cli.js shipped with the build Node.js');
assert.equal(hash(await readFile(options.archive)), manifest.baseSha256, 'Unknown base archive; refusing to patch');
await mkdir(options.out, { recursive: true });
const temporary = await mkdtemp(join(options.out, '.prepare-kylin-'));
try {
  const listing = run('tar', ['-tzf', options.archive], temporary).trim().split(/\r?\n/);
  assert.ok(listing.every(path => path.startsWith('package/') && !path.includes('\\') && !path.split('/').includes('..')));
  run('tar', ['-xzf', options.archive, '-C', temporary], temporary);
  const packageDir = join(temporary, 'package');
  const original = await inventory(packageDir);
  for (const entry of manifest.files) {
    const file = join(packageDir, entry.path);
    let content = await readFile(file, 'utf8');
    assert.equal(hash(content), entry.before, `Unexpected baseline: ${entry.path}`);
    for (const replacement of entry.replacements) {
      assert.equal(content.split(replacement.before).length - 1, replacement.count, `Patch target count: ${entry.path}`);
      content = content.replaceAll(replacement.before, replacement.after);
    }
    await writeFile(file, content);
  }
  const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(metadata.version, manifest.baseVersion);
  metadata.version = manifest.version;
  metadata.description = 'Kylin LoongArch preview: local .univer editing and JS formulas; Office import/export unavailable.';
  metadata.engines.node = manifest.node;
  for (const name of manifest.removedDependencies) {
    assert.ok(metadata.dependencies[name]);
    delete metadata.dependencies[name];
  }
  await writeFile(join(packageDir, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
  await copyFile(join(patches, 'sqlite.cjs'), join(packageDir, 'artifacts/kylin-sqlite.cjs'));
  await copyFile(join(patches, 'INSTALL.zh-CN.md'), join(packageDir, 'docs/KYLIN-PREVIEW.md'));
  const files = await inventory(packageDir);
  const changed = new Set(['package.json', ...manifest.files.map(entry => entry.path)]);
  for (const entry of original) {
    if (!changed.has(entry.path)) assert.equal(files.find(file => file.path === entry.path)?.sha256, entry.sha256, `Unexpected change: ${entry.path}`);
  }
  assert.equal(files.length, original.length + 2);
  const [packed] = JSON.parse(run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], packageDir));
  const archive = await readFile(join(temporary, packed.filename));
  const output = join(options.out, packed.filename);
  if (await exists(output)) assert.equal(hash(await readFile(output)), hash(archive), 'Existing output differs; use a new output directory');
  else await copyFile(join(temporary, packed.filename), output);
  const report = { status: 'built-unverified', version: manifest.version, limitations: ['Office import/export unavailable', 'Screenshots and PDF require an explicitly configured compatible browser'], baseSha256: manifest.baseSha256, output, bytes: archive.length, sha256: hash(archive), files };
  await writeFile(join(options.out, 'kylin-provenance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, bytes: archive.length, sha256: report.sha256 }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
