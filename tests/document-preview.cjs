// Common-format acceptance, reused by the real Electron artifact-link session.
const assert = require('node:assert/strict');
const { copyFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const fixtures = join(__dirname, 'fixtures/document-preview');
const manifest = require('./fixtures/document-preview/manifest.json');
const XLSX = require('xlsx');

exports.install = workspace => {
  const folder = join(workspace, '常见 文档');
  mkdirSync(folder, { recursive: true });
  for (const name of Object.keys(manifest.files)) copyFileSync(join(fixtures, name), join(folder, name));
  copyFileSync(join(fixtures, 'sample.mp4'), join(folder, 'sample.mp4'));
  const workbook = XLSX.readFile(join(fixtures, 'sample.xlsx'));
  XLSX.writeFile(workbook, join(folder, 'legacy.xls'), { bookType: 'xls' });
  XLSX.writeFile(workbook, join(folder, 'sample.ods'), { bookType: 'ods' });
  copyFileSync(join(fixtures, 'sample.docx'), join(folder, '大写.DOCX'));
  writeFileSync(join(folder, 'table.csv'), '\ufeff项目,数量,说明\r\n中文数据,42,"含逗号,仍在一格"\r\n');
  writeFileSync(join(folder, 'broken.docx'), 'This is a damaged Word file.');
  writeFileSync(join(folder, 'old.doc'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  const outside = join(dirname(workspace), '工作区外文本.txt');
  copyFileSync(join(fixtures, 'utf16le.txt'), outside);
  return [...Object.keys(manifest.files).filter(name => name !== 'sample.png'), 'sample.mp4', 'legacy.xls', 'sample.ods', '大写.DOCX', 'table.csv', 'broken.docx', 'old.doc']
    .map(name => `[${name}](常见%20文档/${encodeURIComponent(name)})`).join(' · ') + `\n\n工作区外：\`${outside}\``;
};

exports.run = async ({ host, until, report, data }) => {
  const js = code => host.executeJavaScript(code, true);
  const visible = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.checkVisibility({checkVisibilityCSS:true}))`;
  const open = async name => {
    await js(`Array.from(document.querySelectorAll('.hWmORq_body button[title]')).find(b=>b.title.endsWith(${JSON.stringify('/' + name)})).click()`);
  };
  const text = selector => js(`(${visible(selector)})?.innerText || ''`);
  for (const name of ['utf8.txt', 'utf8-bom.txt', 'utf16le.txt', 'utf16be.txt', 'gbk.txt', '工作区外文本.txt']) {
    await open(name);
    await until(async () => (await text('[data-document-preview="text"]')).includes('桌面文本预览：你好，世界。'), name + ' did not decode Chinese text');
  }
  report.checks.push('Actual sidebar reads UTF-8, UTF-8 BOM, UTF-16LE/BE and GBK Chinese TXT, including a workspace-external absolute path');

  // The Office frame has an opaque origin; inspect it through Electron's test API.
  const officeFrame = async marker => {
    for (const frame of host.mainFrame.framesInSubtree) {
      if (frame === host.mainFrame || frame.detached) continue;
      try { if (await frame.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(marker)})`)) return frame; } catch {}
    }
  };
  await open('大写.DOCX');
  await until(() => js(`(${visible('[data-office-preview="docx"]')})?.dataset.officeStatus === 'ready'`), 'DOCX failed to render');
  const word = await until(() => officeFrame('DOCX_PREVIEW_OK'), 'DOCX preview contains no document text');
  const wordInfo = await word.executeJavaScript(`({text:document.body.innerText,tables:document.querySelectorAll('table').length,images:Array.from(document.images).filter(i=>i.complete&&i.naturalWidth>0).length,desktop:typeof window.dshDesktop,isolated:(()=>{try{return !parent.document}catch{return true}})()})`);
  for (const value of manifest.expected['sample.docx'].text) assert.ok(wordInfo.text.includes(value), value);
  assert.ok(wordInfo.tables >= 1); assert.ok(wordInfo.images >= 1);
  assert.equal(wordInfo.desktop, 'undefined'); assert.equal(wordInfo.isolated, true);
  const fit = await word.executeJavaScript(`(()=>{const r=document.querySelector('section.docx').getBoundingClientRect();return {left:r.left,right:r.right,viewport:innerWidth,mode:document.body.dataset.officeZoom}})()`);
  assert.equal(fit.mode, 'fit'); assert.ok(fit.left >= 0 && fit.right <= fit.viewport + 1, 'Word must fit the narrow sidebar without clipping either edge');
  await word.executeJavaScript(`(()=>{const s=document.querySelector('select[aria-label="文档显示比例"]');s.value='actual';s.dispatchEvent(new Event('change'))})()`);
  assert.ok(await word.executeJavaScript(`document.querySelector('section.docx').getBoundingClientRect().left >= 0`), '100% Word preview must retain a scrollable left edge');
  await word.executeJavaScript(`(()=>{const s=document.querySelector('select[aria-label="文档显示比例"]');s.value='fit';s.dispatchEvent(new Event('change'))})()`);
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  writeFileSync(join(data, 'docx-preview.png'), (await host.capturePage()).toPNG());
  report.checks.push('Chinese/spaced path and uppercase DOCX renders actual text, a table and an image inside an opaque frame with no desktop API');

  await open('sample.xlsx');
  await until(async () => (await text('[data-document-preview="spreadsheet"]')).includes('测试商品'), 'XLSX did not render data');
  assert.match(await text('[data-document-preview="spreadsheet"]'), /74/);
  await js(`Array.from((${visible('[data-document-preview="spreadsheet"]')}).querySelectorAll('button')).find(b=>b.textContent.includes('汇总')).click()`);
  await until(async () => (await text('[data-document-preview="spreadsheet"]')).includes('XLSX_SECOND_SHEET_OK'), 'Second worksheet did not open');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  writeFileSync(join(data, 'xlsx-preview.png'), (await host.capturePage()).toPNG());
  for (const name of ['legacy.xls', 'sample.ods']) {
    await open(name);
    await until(async () => (await text('[data-document-preview="spreadsheet"]')).includes('测试商品'), name + ' did not render Chinese cells');
  }
  await open('table.csv');
  await until(async () => (await text('[data-document-preview="spreadsheet"]')).includes('含逗号,仍在一格'), 'CSV quoted cells or Chinese text failed');
  report.checks.push('XLSX renders Chinese cells and cached formulas, switches worksheets, XLS/ODS open, and CSV preserves quoted commas');

  await open('sample.pptx');
  await until(() => js(`(${visible('[data-office-preview="pptx"]')})?.dataset.officeStatus === 'ready'`), 'PPTX failed to render');
  const slides = await until(() => officeFrame('PPTX_SLIDE_1_OK'), 'PPTX first slide is blank');
  await until(() => slides.executeJavaScript(`document.body.innerText.includes('PPTX_SLIDE_2_OK')`), 'PPTX second slide is blank');
  const slideInfo = await slides.executeJavaScript(`({text:document.body.innerText,images:Array.from(document.images).filter(i=>i.complete&&i.naturalWidth>0).length})`);
  for (const value of manifest.expected['sample.pptx'].text) assert.ok(slideInfo.text.includes(value), value);
  assert.ok(slideInfo.images >= 1, 'PPTX embedded image did not decode');
  writeFileSync(join(data, 'pptx-preview.png'), (await host.capturePage()).toPNG());
  report.checks.push('PPTX renders both Chinese slides and embedded images in the sidebar');

  await open('sample.wav');
  await until(() => js(`(()=>{const a=(${visible('[data-document-preview="media"]')})?.querySelector('audio');return a&&a.readyState>=1&&Math.abs(a.duration-.25)<.01})()`), 'WAV metadata did not load');
  report.checks.push('Audio sidebar exposes playback controls and decodes the local WAV duration');
  await open('sample.mp4');
  await until(() => js(`(()=>{const v=(${visible('[data-document-preview="media"]')})?.querySelector('video');return v&&v.readyState>=2&&v.videoWidth===64&&v.videoHeight===48})()`), 'MP4 first frame did not decode');
  report.checks.push('Video sidebar decodes the real H.264 MP4 frame and exposes playback controls');
  await open('broken.docx');
  await until(() => js(`(${visible('[data-office-preview="docx"]')})?.dataset.officeStatus === 'error'`), 'Damaged DOCX did not show an explicit failure');
  await open('old.doc');
  await until(async () => (await text('[data-document-preview="unsupported-office"]')).includes('DOCX'), 'Legacy DOC did not explain conversion');
  report.checks.push('Damaged Office files and legacy DOC show explicit, actionable states instead of binary text or a blank panel');
};
