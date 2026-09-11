import { build } from 'vite';
import { builtinModules } from 'node:module';
import { copyFile, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyComputerDriverBuild } from './build-computer-driver.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform === 'darwin') await verifyComputerDriverBuild(resolve(root, '.runtime/computer-use'));
const nativeExternals = ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
const auditInstaller = await import(new URL('install-audit-compat.mjs', import.meta.url).href);
await auditInstaller.applyAuditCompat({ nodeModules: resolve(root, '.runtime/node_modules'), pluginRoot: resolve(root, '.runtime/node_modules/dsh-audit-mode'), backupHome: resolve(root, '.build-runtime') });
const artifactInstaller = await import(new URL('install-artifact-links.mjs', import.meta.url).href);
await artifactInstaller.applyArtifactLinks();
const sidebarInstaller = await import(new URL('install-sidebar-autoclose.mjs', import.meta.url).href);
await sidebarInstaller.applySidebarAutoclose();
const progressiveImageInstaller = await import(new URL('install-progressive-images.mjs', import.meta.url).href);
await progressiveImageInstaller.applyProgressiveImages();

for (const entry of ['main', 'preload', 'updater', 'computer-preview-preload']) {
  await build({ configFile: false, root, build: { outDir: resolve(root, 'dist', entry), target: 'node24', lib: { entry: resolve(root, 'src', entry, 'index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' }, rolldownOptions: { external: nativeExternals } } });
}

// Office parsers run in an opaque sandboxed frame, with no DSH preload or network.
const frameBuild = await build({ configFile: false, root, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: {
  write: false, target: 'chrome148', minify: true,
  lib: { entry: resolve(root, 'src/renderer/office-frame/index.ts'), name: 'DSHOfficePreview', formats: ['iife'] },
  rolldownOptions: { output: { codeSplitting: false } },
} });
const frameOutput = Array.isArray(frameBuild) ? frameBuild[0] : frameBuild;
if (!('output' in frameOutput)) throw new Error('Office preview build returned no output.');
const frameScript = frameOutput.output.find(item => item.type === 'chunk' && item.isEntry);
if (!frameScript || frameScript.type !== 'chunk') throw new Error('Office preview entry script is missing.');

const pluginBuild = await build({
  configFile: false,
  root,
  define: { __DSH_OFFICE_FRAME_SCRIPT__: JSON.stringify(frameScript.code) },
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
const pluginOutput = Array.isArray(pluginBuild) ? pluginBuild[0] : pluginBuild;
if (!('output' in pluginOutput)) throw new Error('Desktop plugin build returned no output.');
const documentStyles = pluginOutput.output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.type === 'asset' ? Buffer.from(item.source).toString('utf8') : '').join('\n');
await writeFile(resolve(root, 'dist/renderer/theme.css'), await readFile(resolve(root, 'src/renderer/theme.css'), 'utf8') + '\n' + documentStyles);
for (const [packagePath, files] of [
  ['docx-preview', ['LICENSE']], ['@aiden0z/pptx-renderer', ['LICENSE']], ['xlsx', ['LICENSE', 'dist/LICENSE']],
  ['echarts', ['LICENSE', 'NOTICE', 'licenses']], ['zrender', ['LICENSE']],
  ['echarts/node_modules/tslib', ['LICENSE.txt', 'CopyrightNotice.txt']],
  ['jszip', ['LICENSE.markdown']], ['pako', ['LICENSE']], ['lie', ['license.md']], ['immediate', ['LICENSE.txt']],
  ['readable-stream', ['LICENSE']], ['core-util-is', ['LICENSE']], ['inherits', ['LICENSE']], ['isarray', ['README.md']],
  ['process-nextick-args', ['license.md']], ['safe-buffer', ['LICENSE']], ['string_decoder', ['LICENSE']],
  ['util-deprecate', ['LICENSE']], ['setimmediate', ['LICENSE.txt']],
] as const) for (const file of files) {
  const destination = resolve(root, 'dist/renderer/licenses', packagePath, file);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await cp(resolve(root, 'node_modules', packagePath, file), destination, { recursive: true });
}
await build({
  configFile: false,
  root: resolve(root, 'src/renderer/setup'),
  base: './',
  build: { outDir: resolve(root, 'dist/renderer/setup'), target: 'chrome148', emptyOutDir: true },
});
await build({ configFile: false, root: resolve(root, 'src/renderer/computer-preview'), base: './', build: { outDir: resolve(root, 'dist/renderer/computer-preview'), target: 'chrome148', emptyOutDir: true } });

await mkdir(resolve(root, 'dist/runtime'), { recursive: true });
for (const name of ['index.ts', 'directory-picker.ts', 'computer-use.ts', 'cordis.yml', 'desktop.patch.yml']) await copyFile(resolve(root, 'src/runtime', name), resolve(root, 'dist/runtime', name));
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
