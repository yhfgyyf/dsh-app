const { Menu, clipboard, shell, dialog } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const childProcess = require('node:child_process');

// Observe production OS boundaries while exercising the real renderer and IPC.
// These fixtures must not launch the user's applications or overwrite their clipboard.
const opened = [];
const revealed = [];
const pickers = [];
const pickerResults = [];
const appChoices = [];
let menu;
const originalPopup = Menu.prototype.popup;
const originalOpenPath = shell.openPath;
const originalReveal = shell.showItemInFolder;
const originalDialog = dialog.showOpenDialog;
const originalExecFile = childProcess.execFile;

function install() {
  Menu.prototype.popup = function () { menu = this; };
  shell.openPath = async path => { opened.push(path); return ''; };
  shell.showItemInFolder = path => { revealed.push(path); };
  dialog.showOpenDialog = async (_window, options) => {
    pickers.push(options);
    const path = pickerResults.shift();
    return { canceled: !path, filePaths: path ? [path] : [] };
  };
  childProcess.execFile = (file, args, options, callback) => {
    if (file === '/usr/bin/open' || (file.toLowerCase().endsWith('powershell.exe') && args.includes('-EncodedCommand'))) {
      appChoices.push({ file, args, path: options?.env?.DSH_DESKTOP_OPEN_TARGET });
      (callback ?? options)(null, '', '');
      return {};
    }
    return originalExecFile(file, args, options, callback);
  };
}
function restore() {
  Menu.prototype.popup = originalPopup;
  shell.openPath = originalOpenPath;
  shell.showItemInFolder = originalReveal;
  dialog.showOpenDialog = originalDialog;
  childProcess.execFile = originalExecFile;
}

async function verifySelection(contents, text, until) {
  await contents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
  const position = await contents.executeJavaScript(`(() => {
    const text = ${JSON.stringify(text)};
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      const index = node.textContent.indexOf(text);
      if (index < 0 || !node.parentElement?.getClientRects().length) continue;
      node.parentElement.scrollIntoView({block:'center',behavior:'instant'});
      const range = document.createRange(); range.setStart(node,index); range.setEnd(node,index+text.length);
      const rect = range.getBoundingClientRect();
      if (rect.height > 35) throw Error('Selection fixture must fit on one line');
      getSelection().removeAllRanges();
      return {x:Math.ceil(rect.left),end:Math.floor(rect.right),y:Math.round(rect.top+rect.height/2)};
    }
    throw Error('Selection text missing: '+text);
  })()`, true);
  contents.focus();
  contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: position.x, y: position.y });
  contents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: position.end, y: position.y });
  contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: position.end, y: position.y });
  await until(async () => (await contents.executeJavaScript('getSelection().toString()')) === text, 'Mouse drag did not select: ' + text).catch(async error => {
    error.message += JSON.stringify(await contents.executeJavaScript(`({selection:getSelection().toString(),atPoint:document.elementFromPoint(${position.x},${position.y})?.outerHTML.slice(0,400),position:${JSON.stringify(position)}})`));
    throw error;
  });
  menu = undefined;
  contents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, x: Math.round((position.x + position.end) / 2), y: position.y });
  contents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, x: Math.round((position.x + position.end) / 2), y: position.y });
  await until(() => menu, 'Native selection context menu missing');
  const copy = menu.items.find(item => item.label === '复制');
  assert.ok(copy?.enabled, 'Copy is unavailable for the actual selected text');
  // Substitute only the clipboard write; never touch the host clipboard.
  const originalWrite = clipboard.writeText;
  let copied;
  clipboard.writeText = value => { copied = value; };
  try { copy.click(copy, null, {}); } finally { clipboard.writeText = originalWrite; }
  assert.equal(copied, text);
  assert.equal(menu.items.some(item => item.label === '剪切'), false);
}

async function verifyLocalFile(host, workspace, filename, until) {
  const count = opened.length;
  await host.executeJavaScript(`document.querySelector('button[aria-label="在本地打开"]').click()`, true);
  await until(() => opened.length === count + 1, 'Local open did not reach the OS');
  assert.equal(opened.at(-1), join(workspace, filename), 'Header opened the workspace instead of the active file');
  assert.equal(await host.executeJavaScript(`document.querySelectorAll('.CAgGvG_split').length`), 0, 'Workspace-only upstream button was not shadowed');
}

async function verifyLocalMenu(host, workspace, until) {
  const js = code => host.executeJavaScript(code, true);
  await until(() => js(`!document.querySelector('button[aria-label="选择本地打开方式"]').disabled`), 'Local open remained busy');
  await js(`document.querySelector('button[aria-label="选择本地打开方式"]').click()`);
  await until(() => js(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find(el=>el.textContent.includes('在文件夹中显示'))`), 'Local open menu missing');
  await js(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(el=>el.textContent.includes('在文件夹中显示')).click()`);
  await until(() => revealed.length > 0, 'Reveal did not reach the OS');
  assert.equal(revealed.at(-1), join(workspace, 'report.md'));
  await until(() => js(`!document.querySelector('button[aria-label="选择本地打开方式"]').disabled`), 'Reveal remained busy');
  if (process.platform === 'darwin') pickerResults.push('/Applications/Preview.app');
  await js(`document.querySelector('button[aria-label="选择本地打开方式"]').click()`);
  await js(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(el=>el.textContent.includes('选择其他应用')).click()`);
  await until(() => appChoices.length > 0, 'Choose app did not reach the OS');
  const choice = appChoices.at(-1);
  if (process.platform === 'win32') {
    assert.equal(choice.path, join(workspace, 'report.md'));
    const script = Buffer.from(choice.args.at(-1), 'base64').toString('utf16le');
    assert.ok(script.includes('[OpenWith]::SHOpenWithDialog'));
    assert.equal(script.includes(workspace), false);
    // Compile the exact production interop on Windows without opening an application.
    const compile = script.slice(0, script.indexOf('$info = New-Object')) + "\nWrite-Output 'OPEN_WITH_COMPILED'";
    const output = childProcess.execFileSync(choice.file, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.match(output, /OPEN_WITH_COMPILED/);
  } else assert.deepEqual(choice.args, ['-a', '/Applications/Preview.app', join(workspace, 'report.md')]);
  for (const [label, path, property] of [['选择文件…', join(workspace, 'my image.svg'), 'openFile'], ['选择文件夹…', workspace, 'openDirectory']]) {
    pickerResults.push(path);
    await until(() => js(`!document.querySelector('button[aria-label="选择本地打开方式"]').disabled`), 'Local action remained busy');
    await js(`document.querySelector('button[aria-label="选择本地打开方式"]').click()`);
    await js(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(el=>el.textContent===${JSON.stringify(label)}).click()`);
    await until(() => opened.at(-1) === path, 'Picker did not open the chosen target');
    assert.deepEqual(pickers.at(-1).properties, [property]);
  }
}

async function verifyNoActiveFile(host, workspace, until) {
  const before = opened.length;
  pickerResults.push(join(workspace, 'my image.svg'));
  await host.executeJavaScript(`document.querySelector('button[aria-label="在本地打开"]').click()`, true);
  await until(() => opened.length === before + 1, 'No-active-file action did not select a file');
  assert.equal(opened.at(-1), join(workspace, 'my image.svg'));
  assert.deepEqual(pickers.at(-1).properties, ['openFile']);
}

module.exports = { install, restore, verifySelection, verifyLocalFile, verifyLocalMenu, verifyNoActiveFile };
