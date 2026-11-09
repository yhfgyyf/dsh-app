import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runtimeManifest } from '../../../scripts/runtime-manifest.ts';

const metadata = JSON.parse(await readFile('.test-data/rc1-plugins/installer/windows-artifact.json', 'utf8'));
assert.equal(metadata.sha256, 'ab9f92492fa477cba57a08fff256069b566d04ac45751b3d49973ef240d4767c');
const actual = await runtimeManifest('.runtime');
assert.equal(actual.sha256, metadata.runtime.sha256);
assert.equal(actual.fileCount, metadata.runtime.fileCount);
const core = JSON.parse(await readFile('.runtime/node_modules/@deepseek-ai/dsh/package.json', 'utf8')).version;
assert.equal(core, '0.2.2-rc.1');
assert.equal(execFileSync('.runtime/bin/node.exe', ['--version'], { encoding: 'utf8' }).trim(), 'v24.15.0');
const report = { passed: true, sourceInstallerCi: 42576612043, installerSha256: metadata.sha256, runtimeSha256: actual.sha256, files: actual.fileCount, core };
await writeFile('.test-data/rc1-plugins/runtime-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
