import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const upstream = fileURLToPath(new URL('../.runtime/node_modules/@deepseek-ai/', import.meta.url));
const classMap = {
  'ui-layout': ['pI_x6G_frame'],
  'ui-sidebar': ['hHd-Xa_root', 'hHd-Xa_logoRow', 'hHd-Xa_newSession', 'hHd-Xa_collapsed'],
  'ui-workspace': ['YDXeBa_sessionRow', 'YDXeBa_projectRow', 'bhn1Oq_searchButton'],
  'ui-settings-general': ['VOzbGW_trigger', 'VOzbGW_panel', 'VOzbGW_nav', 'VOzbGW_navCell'],
  'ui-chat': ['Sixlwa_bubble'],
};

test('the installed DSH version still exports every CSS-module control used by the desktop adapter', async () => {
  for (const [module, classes] of Object.entries(classMap)) {
    const source = await readFile(upstream + `dsh-client-${module}/lib/client.js`, 'utf8');
    for (const className of classes) assert.ok(source.includes(`"${className}"`), `${module}: ${className} changed; review the desktop adapter`);
  }
});

test('the installed HMR driver reloads individual entries and does not replace the desktop boot graph', async () => {
  const source = await readFile(upstream + 'dsh-client-hmr/lib/client.js', 'utf8');
  assert.match(source, /case "graph": break;/);
  assert.match(source, /case "rebuilt"/);
  assert.match(source, /entry\.refresh\(\)/);
});
