import { build } from 'vite';
import { builtinModules, createRequire } from 'node:module';
import { cp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('.', import.meta.url)), repo = fileURLToPath(new URL('../..', import.meta.url));
const distribution = join(root, 'dist'), plugin = join(distribution, 'plugins', 'dsh-codex-collab');
await build({ configFile: false, root, build: { outDir: plugin, target: 'node24', emptyOutDir: true, minify: false,
  lib: { entry: join(root, 'src/cli.ts'), formats: ['es'], fileName: () => 'cli.mjs' },
  rolldownOptions: { external: [...builtinModules, ...builtinModules.map(n => 'node:' + n)],
    output: { banner: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);' } },
} });
await cp(join(root, 'plugin'), plugin, { recursive: true });
// ws is already a relay production dependency. Keep its loader and optional native fallbacks intact.
const require = createRequire(new URL('../relay/package.json', import.meta.url)), ws = dirname(require.resolve('ws/package.json'));
await cp(ws, join(plugin, 'node_modules/ws'), { recursive: true });
for (const [name, license] of [['qrcode', 'license'], ['pngjs', 'LICENSE'], ['dijkstrajs', 'LICENSE.md']] as const) {
  await mkdir(join(plugin, 'licenses', name), { recursive: true });
  await cp(join(repo, 'node_modules', name, license), join(plugin, 'licenses', name, license));
}
await mkdir(join(distribution, '.agents/plugins'), { recursive: true });
await writeFile(join(distribution, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'dsh-local', interface: { displayName: 'DSH local integrations' },
  plugins: [{ name: 'dsh-codex-collab', source: { source: 'local', path: './plugins/dsh-codex-collab' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2) + '\n');
const files: { path: string; sha256: string }[] = [];
async function visit(directory: string, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), relative = prefix + entry.name;
    if (entry.isDirectory()) await visit(path, relative + '/');
    else files.push({ path: relative, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
}
await visit(plugin);
await writeFile(join(distribution, 'manifest.json'), JSON.stringify({ version: '0.1.0', files }, null, 2) + '\n');
console.log(`Packaged ${files.length} files at ${distribution}`);
