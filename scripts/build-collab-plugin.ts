import { build } from 'vite';
import { builtinModules } from 'node:module';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCollabPlugin(root = fileURLToPath(new URL('..', import.meta.url))) {
  const output = resolve(root, '.runtime/plugins/dsh-p2p-collab');
  const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
  await mkdir(output, { recursive: true });
  await build({ configFile: false, root, build: { outDir: output, emptyOutDir: true, target: 'node24', minify: false,
    lib: { entry: resolve(root, 'src/runtime/collab-host.ts'), formats: ['es'], fileName: () => 'index.js' },
    rolldownOptions: { external: [...builtinModules, ...builtinModules.map(m => 'node:' + m)] } } });
  const css = await readFile(resolve(root, 'src/renderer/collab.css'), 'utf8');
  await build({ configFile: false, root, define: { __DSH_COLLAB_CSS__: JSON.stringify(css) }, build: { outDir: output, emptyOutDir: false, target: 'chrome148',
    lib: { entry: resolve(root, 'src/renderer/collab-plugin.tsx'), formats: ['cjs'], fileName: () => 'client.js' },
    rolldownOptions: { external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], output: {
      banner: 'window.__ModuleLoader__.load({id:"dsh-p2p-collab",factory:(require)=>{const module={exports:{}};const exports=module.exports;',
      footer: 'return module.exports;}});',
    } } } });
  await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: 'dsh-p2p-collab', version: '0.1.2', private: true, type: 'module',
    description: 'P2P 协作：浏览任务、讨论、本机求解和共享解决方案', main: 'index.js', exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
    dshDesktopVersion: version, keywords: ['dsh-plugin'], dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: [
      '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-primitives',
    ] } } }, null, 2));
  await writeFile(resolve(output, 'cordis.patch.yml'), "- insert:\n    - id: p2p-collab\n      name: dsh-p2p-collab\n");
  await cp(output, resolve(root, '.runtime/node_modules/dsh-p2p-collab'), { recursive: true });
  const manifestPath = resolve(root, '.runtime/package.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies['dsh-p2p-collab'] = 'file:./plugins/dsh-p2p-collab';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
