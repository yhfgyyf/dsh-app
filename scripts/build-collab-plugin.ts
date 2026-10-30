import { build } from 'vite';
import { builtinModules } from 'node:module';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_VERSION } from '../src/runtime/collab-host.ts';

export async function buildCollabPlugin(root = fileURLToPath(new URL('..', import.meta.url)), standalone = false) {
  const output = resolve(root, standalone ? 'dist/dsh-p2p-collab' : '.runtime/plugins/dsh-p2p-collab');
  const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')), version = metadata.dshDesktopVersion ?? metadata.version;
  const licenses = await Promise.all([['qrcode', 'license'], ['pngjs', 'LICENSE'], ['dijkstrajs', 'LICENSE.md']].map(async ([name, file]) => `${name}\n${await readFile(resolve(root, 'node_modules', name, file), 'utf8')}`));
  await mkdir(output, { recursive: true });
  await build({ configFile: false, root, build: { outDir: output, emptyOutDir: true, target: 'node20', minify: false,
    lib: { entry: resolve(root, 'src/runtime/collab-plugin-host.ts'), formats: ['es'], fileName: () => 'index.js' },
    rolldownOptions: { external: [...builtinModules, ...builtinModules.map(m => 'node:' + m)],
      output: { banner: `/*! Bundled dependency licenses\n${licenses.join('\n\n').replaceAll('*/', '* /')}\n*/\nimport { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);` } } } });
  const css = await readFile(resolve(root, 'src/renderer/collab.css'), 'utf8');
  await build({ configFile: false, root, define: { __DSH_COLLAB_CSS__: JSON.stringify(css) }, build: { outDir: output, emptyOutDir: false, target: 'chrome126',
    lib: { entry: resolve(root, 'src/renderer/collab-plugin.tsx'), formats: ['cjs'], fileName: () => 'client.js' },
    rolldownOptions: { external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], output: {
      banner: 'window.__ModuleLoader__.load({id:"dsh-p2p-collab",factory:(require)=>{const module={exports:{}};const exports=module.exports;',
      footer: 'return module.exports;}});',
    } } } });
  await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: 'dsh-p2p-collab', version: PLUGIN_VERSION, private: true, type: 'module',
    description: '协作空间：任务对话、进展与方案、一次或持续 AI 参与', main: 'index.js', engines: { node: '>=22' }, exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
    dshDesktopVersion: version, keywords: ['dsh-plugin'], dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: [
      '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-primitives',
    ] } } }, null, 2));
  await writeFile(resolve(output, 'cordis.patch.yml'), "- insert:\n    - id: p2p-collab\n      name: dsh-p2p-collab\n");
  if (standalone) return output;
  await cp(output, resolve(root, '.runtime/node_modules/dsh-p2p-collab'), { recursive: true });
  const manifestPath = resolve(root, '.runtime/package.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies['dsh-p2p-collab'] = 'file:./plugins/dsh-p2p-collab';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
