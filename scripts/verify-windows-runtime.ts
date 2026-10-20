import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extractFile } from '@electron/asar';
import { runtimeManifest } from './runtime-manifest.ts';
const [installed, packaged] = process.argv.slice(2);
if (!installed || !packaged) throw new Error('Expected installed and packaged directories');
assert.deepEqual(await readFile(join(installed, 'resources/app.asar')), await readFile(join(packaged, 'resources/app.asar')));
for (const path of ['dist/renderer/content-find/index.html', 'dist/content-find-preload/index.cjs']) {
  assert.deepEqual(extractFile(join(installed, 'resources/app.asar'), normalize(path)), await readFile(new URL('../' + path, import.meta.url)));
}
assert.doesNotMatch(extractFile(join(installed, 'resources/app.asar'), join('dist', 'renderer', 'theme.css')).toString(), /\.desktop-content-find-scope|\.desktop-content-find\s*\{/);
assert.deepEqual(await runtimeManifest(join(installed, 'resources/runtime')), await runtimeManifest(join(packaged, 'resources/runtime')));
const runtime = join(installed, 'resources/runtime');
assert.deepEqual(JSON.parse(await readFile(join(runtime, 'local-plugins/package.json'), 'utf8')), { private: true });
for (const path of ['plugins/dsh-p2p-collab', 'node_modules/dsh-p2p-collab']) assert.equal(existsSync(join(runtime, path)), false);
assert.equal(JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).dependencies?.['dsh-p2p-collab'], undefined);
const pins = JSON.parse(await readFile(new URL('../runtime/dependencies.json', import.meta.url), 'utf8'));
assert.equal(JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, pins.dsh);
assert.match(execFileSync(join(installed, 'resources/runtime/bin/node.exe'), ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: process.env.SystemRoot ?? 'C:\\Windows' } }), /^v24\./);
console.log('Installed Windows app and runtime verified.');
