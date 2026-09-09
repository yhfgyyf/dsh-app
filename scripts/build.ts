import { build } from 'vite';
import { builtinModules } from 'node:module';
import { copyFile, mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nativeExternals = ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
const artifactInstaller = await import(new URL('install-artifact-links.mjs', import.meta.url).href);
await artifactInstaller.applyArtifactLinks();
const sidebarInstaller = await import(new URL('install-sidebar-autoclose.mjs', import.meta.url).href);
await sidebarInstaller.applySidebarAutoclose();

for (const entry of ['main', 'preload', 'updater']) {
  await build({ configFile: false, root, build: { outDir: resolve(root, 'dist', entry), target: 'node24', lib: { entry: resolve(root, 'src', entry, 'index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' }, rolldownOptions: { external: nativeExternals } } });
}

await build({
  configFile: false,
  root,
  build: {
    outDir: resolve(root, 'dist/renderer'),
    target: 'chrome148',
    emptyOutDir: true,
    lib: { entry: resolve(root, 'src/renderer/plugin.tsx'), formats: ['cjs'], fileName: () => 'plugin.js' },
    rolldownOptions: {
      external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
      output: {
        banner: 'window.__ModuleLoader__.load({id:"dsh-desktop-shell",factory:(require)=>{const module={exports:{}};const exports=module.exports;',
        footer: 'return module.exports;}});',
      },
    },
  },
});

await mkdir(resolve(root, 'dist/renderer'), { recursive: true });
await copyFile(resolve(root, 'src/renderer/theme.css'), resolve(root, 'dist/renderer/theme.css'));
await build({
  configFile: false,
  root: resolve(root, 'src/renderer/setup'),
  base: './',
  build: { outDir: resolve(root, 'dist/renderer/setup'), target: 'chrome148', emptyOutDir: true },
});

await mkdir(resolve(root, 'dist/runtime'), { recursive: true });
for (const name of ['index.ts', 'directory-picker.ts', 'cordis.yml', 'desktop.patch.yml']) await copyFile(resolve(root, 'src/runtime', name), resolve(root, 'dist/runtime', name));
await build({ configFile: false, plugins: [{
  name: 'desktop-browser-loader',
  transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/@deepseek-ai/cordis-plugin-loader/lib/index.js')) return;
    // The shared Loader publishes a Node default. Desktop renderer supplies its
    // own module system, so remove exactly the two host-only initializers.
    const env = 'envData = process.env.CORDIS_SHARED ? JSON.parse(process.env.CORDIS_SHARED) : { startTime: Date.now() };';
    const internal = 'internal = ModuleLoader.fromInternal();';
    if (!code.includes(env) || !code.includes(internal)) throw new Error('Pinned Loader browser adapter contract changed.');
    return code.replace(env, 'envData = { startTime: Date.now() };').replace(internal, 'internal = undefined;');
  },
}], root: resolve(root, 'src/renderer'), base: '/__dsh_desktop__/app/', build: { outDir: resolve(root, 'dist/renderer/app'), target: 'chrome148', emptyOutDir: true } });

await cp(resolve(root, 'dist/runtime'), resolve(root, '.runtime/app'), { recursive: true });
