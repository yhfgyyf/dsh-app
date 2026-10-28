// Check the delivered payload and the real core's compatibility decisions.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [packageArg, provenanceArg, reportArg] = process.argv.slice(2);
assert.ok(packageArg && provenanceArg && reportArg, 'Expected extracted package, provenance JSON and report directory');
const packageDir = resolve(packageArg), reportDir = resolve(reportArg);
const provenance = JSON.parse(await readFile(provenanceArg, 'utf8'));
const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const runtime = resolve(process.env.DSH_TEST_RUNTIME ?? join(root, '.runtime'));
const require = createRequire(join(runtime, 'package.json'));
const { evaluatePluginCompatibility } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
const checks = [];
assert.equal(metadata.version, '0.3.5-universal.1');
assert.equal(metadata.version, provenance.version);
assert.equal(metadata.os, undefined); assert.equal(metadata.cpu, undefined);
for (const entry of provenance.files) {
  assert.equal(createHash('sha256').update(await readFile(join(packageDir, entry.path))).digest('hex'), entry.sha256, entry.path);
}
checks.push('All delivered payload files match the reviewed universal build, without an OS/CPU package restriction');
for (const name of ['libsql', '@univerjs-pro/engine-formula-rust-binding', '@univerjs-pro/exchange-node-binding']) {
  assert.equal(metadata.dependencies[name], undefined);
  assert.ok(metadata.optionalDependencies[name]);
}
assert.equal(metadata.optionalDependencies['@univerjs-pro/engine-formula-rust-binding'], '1.0.1');
assert.equal(metadata.optionalDependencies['@univerjs-pro/exchange-node-binding'], '1.0.1');
checks.push('Unavailable native modules are optional, with the existing native binding versions preserved');
for (const version of ['0.2.0-rc.1', '0.2.1-rc.2']) assert.equal(evaluatePluginCompatibility(metadata, {}, version), undefined);
for (const version of ['0.2.1-rc.3', '0.3.0']) assert.ok(evaluatePluginCompatibility(metadata, {}, version));
checks.push('The official checker accepts exactly the added core release while retaining rc.1 support and rejecting unverified future releases');
for (const name of ['old-desktop', 'old-kylin']) {
  const original = JSON.parse(await readFile(join(root, 'tests/fixtures', `univer-${name}.json`), 'utf8'));
  const rejected = evaluatePluginCompatibility(original, {}, '0.2.1-rc.2');
  assert.equal(rejected.exempted, false); assert.equal(rejected.runtimeVersion, '0.2.1-rc.2');
}
checks.push('Both previously shipped plugin variants reproduce the reported incompatibility; the universal candidate needs no exemption');
await mkdir(reportDir, { recursive: true });
const result = { status: 'pass', version: metadata.version, core: '0.2.1-rc.2', platform: process.platform, architecture: process.arch, checks };
await writeFile(join(reportDir, 'universal-compatibility.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
