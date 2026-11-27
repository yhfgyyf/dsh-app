// Run with DSH_TEST_CHROMIUM pointing to a Chromium 126 executable, or use Playwright's installed browser.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../.runtime/node_modules/playwright-core/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = resolve(root, '.test-data');
await mkdir(temp, { recursive: true });
const directory = await mkdtemp(join(temp, 'kylin-reply-'));
let browser;
try {
  const entry = join(directory, 'entry.tsx');
  await writeFile(entry, `
    import { createRoot } from 'react-dom/client';
    import { KylinChatReply } from '../../src/renderer/kylin-chat-reply.tsx';
    const closing = { turn: 1, step: 5, finalNode: { seq: 41, messageId: 'reply' },
      blocks: [{ kind: 'reasoning', text: 'private reasoning' }, { kind: 'text', text: '目录\\n\\n|文件|大小|\\n|---|---|\\n|a.txt|7|' }] };
    createRoot(document.getElementById('tail')).render(<KylinChatReply seq={41}
      turn={{ data: { get: () => ({ closing, branchUnavailable: false }) } }} />);
  `);
  const result = await build({ root, configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: {
    target: 'chrome126', write: false, lib: { entry, name: 'test', formats: ['iife'] },
  } });
  const script = (Array.isArray(result) ? result[0] : result).output.find(file => file.type === 'chunk').code;
  browser = await chromium.launch({ executablePath: process.env.DSH_TEST_CHROMIUM });
  const page = await browser.newPage();
  page.setDefaultTimeout(4500);
  page.on('pageerror', error => console.error(error.message));
  await page.setContent(`<div data-chat-flow>
    <div data-chat-turn="1" data-chat-flow-kind="assistant-step" data-chat-node-key="14:assistant-step1:4"><p data-text-interaction-source>Earlier step</p></div>
    <div id="tail"></div></div>`);
  await page.addScriptTag({ content: script });
  const recovery = page.locator('[data-desktop-recovered-reply]');
  await recovery.locator('table').waitFor();
  assert.doesNotMatch(await recovery.innerText(), /private reasoning/);
  await page.evaluate(() => {
    const row = document.querySelector('[data-chat-flow-kind]').cloneNode(true);
    row.dataset.chatNodeKey = '14:assistant-step1:5';
    row.firstChild.textContent = 'Original reply';
    document.querySelector('#tail').before(row);
  });
  await recovery.waitFor({ state: 'detached' });
  const row = page.locator('[data-chat-node-key="14:assistant-step1:5"]');
  await row.evaluate(element => { element.hidden = true; });
  await recovery.locator('table').waitFor();
  await row.evaluate(element => { element.hidden = false; });
  await recovery.waitFor({ state: 'detached' });
  const style = await page.addStyleTag({ content: '[data-text-interaction-source]:not([data-desktop-recovered-reply]), [data-desktop-recovered-reply] > [class] { display: none !important }' });
  await recovery.waitFor();
  assert.equal(await recovery.innerText(), '目录\n\n|文件|大小|\n|---|---|\n|a.txt|7|');
  await style.evaluate(element => element.remove());
  await recovery.waitFor({ state: 'detached' });
  console.log('Closing reply recovered, earlier step and reasoning excluded, formatted and plain text verified, duplicate removed.');
} finally {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
