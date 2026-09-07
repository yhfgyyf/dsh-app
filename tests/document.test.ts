import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('desktop owns both entrypoints and cannot load the Web App startup or page', async () => {
  const [runtime, frontend, composition, main] = await Promise.all(['src/runtime/index.ts', 'src/renderer/entry.tsx', 'src/runtime/desktop.patch.yml', 'src/main/index.ts'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')));
  assert.match(runtime, /await boot\(/);
  assert.match(frontend, /new Cordis.Context\(/);
  assert.match(frontend, /getBoot\(/);
  assert.doesNotMatch(frontend, /AppWebEntry|dsh-client-web|__DSH_BOOT__/);
  assert.doesNotMatch(composition, /dsh-web-app|webStartup|webRuntime|dsh-frontend-static/);
  assert.doesNotMatch(main, /decorateDshDocument|--url/);
});
