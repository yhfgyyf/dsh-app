import { build } from 'vite';
import { builtinModules, createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
await build({ configFile: false, root, build: { outDir: join(root, '.test-data/computer-native-build'), target: 'node24', lib: { entry: join(root, 'tests/computer-native.ts'), formats: ['cjs'], fileName: () => 'test.cjs' }, rolldownOptions: { external: ['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)] } } });
const require = createRequire(import.meta.url);
const code = await new Promise<number | null>((resolve, reject) => {
  const child = spawn(require('electron'), [join(root, '.test-data/computer-native-build/test.cjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, DSH_COMPUTER_TEST_ROOT: root } });
  child.once('error', reject); child.once('exit', resolve);
});
if (code !== 0) process.exitCode = 1;
