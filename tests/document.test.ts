import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

test('desktop owns both entrypoints and cannot load the Web App startup or page', async () => {
  const [runtime, frontend, composition, main] = await Promise.all(['src/runtime/index.ts', 'src/renderer/entry.tsx', 'src/runtime/desktop.patch.yml', 'src/main/index.ts'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')));
  assert.match(runtime, /await boot\(/);
  assert.match(frontend, /new Cordis.Context\(/);
  assert.match(frontend, /getBoot\(/);
  assert.doesNotMatch(frontend, /AppWebEntry|dsh-client-web|__DSH_BOOT__/);
  assert.doesNotMatch(composition, /dsh-web-app|webStartup|webRuntime|dsh-frontend-static/);
  assert.doesNotMatch(main, /decorateDshDocument|--url/);
});

test('desktop composition packages import from the pinned runtime', async () => {
  const requireRuntime = createRequire(new URL('../.runtime/package.json', import.meta.url));
  const sources = await Promise.all([
    readFile(requireRuntime.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8'),
    readFile(new URL('../src/runtime/desktop.patch.yml', import.meta.url), 'utf8'),
  ]);
  const packages = [...new Set(sources.flatMap(source => [...source.matchAll(/^\s+name: '?([^'\s]+)'?$/gm)].map(match => match[1])).filter(name => !name.startsWith('.')))];
  assert.ok(packages.length > 0);
  for (const name of packages) await assert.doesNotReject(import(pathToFileURL(requireRuntime.resolve(name)).href), name);
});
