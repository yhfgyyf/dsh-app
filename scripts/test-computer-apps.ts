import { build } from 'vite';
import { builtinModules, createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '.test-data/computer-apps-build');
const previewRoot = join(output, 'preview');
const external = ['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)];
await build({ configFile: false, root, build: { outDir: output, target: 'node24', lib: { entry: join(root, 'tests/computer-apps.ts'), formats: ['cjs'], fileName: () => 'test.cjs' }, rolldownOptions: { external } } });
await build({ configFile: false, root, build: { outDir: join(previewRoot, 'dist/computer-preview-preload'), target: 'node24', lib: { entry: join(root, 'src/computer-preview-preload/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' }, rolldownOptions: { external } } });
await build({ configFile: false, root: join(root, 'src/renderer/computer-preview'), base: './', build: { outDir: join(previewRoot, 'dist/renderer/computer-preview'), target: 'chrome148', emptyOutDir: true } });

if (!process.argv.includes('--build-only')) {
  if (process.platform !== 'darwin') throw new Error('The Blender/TextEdit app fixture currently requires macOS.');
  const require = createRequire(import.meta.url);
  const executable = process.env.DSH_COMPUTER_TEST_ELECTRON || require('electron');
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(executable, [join(output, 'test.cjs')], {
      cwd: root, stdio: 'inherit',
      env: { ...process.env, DSH_COMPUTER_TEST_ROOT: root, DSH_COMPUTER_PREVIEW_ROOT: previewRoot },
    });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
}
