import { build } from 'vite';
import { builtinModules, createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '.test-data/computer-settings-build');
await build({ configFile: false, root, define: { 'process.env.NODE_ENV': '"production"' }, build: { outDir: output, target: 'chrome148', lib: { entry: join(root, 'tests/audit-dock-renderer.tsx'), name: 'AuditRenderFixture', formats: ['iife'], fileName: () => 'audit.js' } } });
await build({ configFile: false, root, resolve: { alias: [{ find: /.*\/(computer-use-driver|macos-privacy)\.ts$/, replacement: join(root, 'tests/computer-settings-driver.ts') }] }, build: { outDir: output, emptyOutDir: false, target: 'node24', lib: { entry: join(root, 'tests/computer-settings.ts'), formats: ['cjs'], fileName: () => 'test.cjs' }, rolldownOptions: { external: ['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)] } } });
const require = createRequire(import.meta.url);
const code = await new Promise<number | null>((resolve, reject) => {
  const child = spawn(require('electron'), [join(output, 'test.cjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, DSH_SETTINGS_TEST_ROOT: root } });
  child.once('error', reject); child.once('exit', resolve);
});
if (code !== 0) process.exitCode = 1;
