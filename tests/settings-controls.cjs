// Exercise actual pointer targets in an isolated Desktop instance, with its own settings and account state.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('../.runtime/node_modules/playwright-core');

async function openSettings(page) {
  const avatar = page.getByRole('button', { name: '账号菜单' });
  await avatar.waitFor();
  const top = () => page.locator('#root').evaluate(root => root.getBoundingClientRect().top);
  const before = await top();
  await avatar.click();
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name: '设置' }).waitFor();
  assert.equal(await menu.evaluate(e => getComputedStyle(e).position), 'fixed', 'Account menu is in the document flow');
  assert.equal(await top(), before, 'Opening the account menu moved the application');
  await menu.getByRole('menuitem', { name: '设置' }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await dialog.waitFor();
  return dialog;
}

async function verifySettings(page) {
  page.setDefaultTimeout(12000);
  const dialog = await openSettings(page);
  const upload = dialog.getByRole('switch', { name: '在使用官方模型 API 时上传 Session Log' });
  await upload.and(dialog.locator(':enabled')).waitFor();
  assert.equal(await upload.getAttribute('aria-checked'), 'false', 'A fresh Desktop profile must opt out of session-log uploads');
  const config = dialog.getByRole('button', { name: '打开配置文件' });
  assert.ok(await config.evaluate(b => parseFloat(getComputedStyle(b).borderRadius) > 0), 'Settings button is unstyled');
  const selectors = dialog.locator('button[aria-haspopup="menu"]');
  const names = await selectors.allTextContents();
  assert.ok(names.includes('标准'));
  for (const [index, name] of names.entries()) {
    const button = selectors.nth(index);
    await button.click();
    const menu = page.getByRole('menu');
    const item = menu.getByRole('menuitem').first();
    await item.waitFor();
    const hit = await item.evaluate(e => {
      const r = e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    assert.ok(hit, 'Cannot reach popup choices for ' + name);
    const choices = await menu.getByRole('menuitem').allTextContents();
    // Choose read-only when checking permissions. Restore each row before trying the next one.
    const next = name === '工作区内修改' ? '仅可查看' : choices.find(choice => choice !== name);
    assert.ok(next, 'Missing alternate option for ' + name);
    await menu.getByRole('menuitem', { name: next, exact: true }).click();
    await menu.waitFor({ state: 'hidden' });
    // The dialog's accessible name changes when changing the UI language.
    const selected = page.getByRole('dialog').locator('button[aria-haspopup="menu"]').nth(index);
    await page.waitForFunction(({ index, next }) =>
      document.querySelectorAll('[role="dialog"] button[aria-haspopup="menu"]')[index]?.textContent === next,
    { index, next });
    if (name !== '标准') {
      await selected.click();
      await page.getByRole('menuitem', { name, exact: true }).click();
      await menu.waitFor({ state: 'hidden' });
      await page.waitForFunction(({ index, name }) =>
        document.querySelectorAll('[role="dialog"] button[aria-haspopup="menu"]')[index]?.textContent === name,
      { index, name });
    }
  }
  const toggle = dialog.getByRole('switch', { name: '显示代码工作视图' });
  const original = await toggle.getAttribute('aria-checked');
  const box = await toggle.boundingBox();
  assert.ok(box && box.width >= 28 && box.height >= 16, 'Code view switch lacks its usable pointer target');
  await toggle.click();
  await dialog.locator('[role="switch"][aria-label="显示代码工作视图"][aria-checked="' + (original !== 'true') + '"]').waitFor();

  await page.reload();
  await openSettings(page);
  const stepButton = selectors.nth(names.indexOf('标准'));
  await stepButton.filter({ hasText: /^简洁$/ }).waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), String(original !== 'true'));
  await toggle.click();
  await stepButton.click();
  await page.getByRole('menuitem', { name: '标准', exact: true }).click();
  await dialog.getByRole('button', { name: '标准', exact: true }).waitFor();

  const dark = dialog.getByRole('button', { name: '深色', exact: true });
  await dark.click();
  await dialog.locator('button[aria-pressed="true"]').filter({ hasText: '深色' }).waitFor();
  await dialog.getByRole('button', { name: '跟随系统', exact: true }).click();
  const nav = dialog.getByRole('navigation');
  const sections = await nav.getByRole('button').allTextContents();
  for (const name of sections) {
    await nav.getByRole('button', { name, exact: true }).click();
    if (name === '插件管理') {
      await page.getByRole('heading', { name: '插件', exact: true }).waitFor();
      await page.getByRole('button', { name: '查看 子智能体' }).click();
      await page.getByRole('switch', { name: '允许 Agent 为子智能体选择模型' }).waitFor();
      await page.getByRole('button', { name: '返回插件' }).click();
      await openSettings(page);
    } else {
      await dialog.waitFor();
    }
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click();
  await dialog.waitFor({ state: 'hidden' });
  return { menus: names, sections, switchPersisted: true };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-settings-ui-'));
  const executable = process.env.DSH_TEST_EXECUTABLE || require('electron');
  const args = process.argv.slice(2);
  const child = spawn(executable, [...(args.length || process.env.DSH_TEST_EXECUTABLE ? args : [root]), '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--lang=zh-CN', '--use-mock-keychain'], {
    env: { ...process.env, DSH_DESKTOP_DATA_DIR: data, DSH_DESKTOP_CONFIG_HOME: data, DSH_HOME: data },
    stdio: 'ignore',
  });
  const exit = new Promise(resolve => child.once('close', resolve));
  let launchError;
  child.on('error', error => { launchError = error; });
  let browser;
  try {
    let port;
    for (let i = 0; i < 120 && child.exitCode === null && !launchError; i++) {
      port = await fs.readFile(path.join(data, 'DevToolsActivePort'), 'utf8').catch(() => '');
      if (port.includes('\n')) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (launchError) throw launchError;
    assert.ok(port?.includes('\n'), 'Failed to start isolated Electron debugging endpoint');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port.split('\n')[0]);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] ?? await ctx.waitForEvent('page', { timeout: 30000 });
    await page.getByRole('button', { name: '账号菜单' }).waitFor({ timeout: 60000 });
    console.log(JSON.stringify(await verifySettings(page)));
  } finally {
    await browser?.close();
    if (process.platform === 'win32' && child.pid && child.exitCode === null) {
      try {
        await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File',
          path.join(root, 'scripts/quit-windows-test-app.ps1'), '-ApplicationId', String(child.pid)], { timeout: 20000 });
        await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 12000).unref())]);
      } finally {
        if (child.exitCode === null) child.kill();
      }
    } else if (child.exitCode === null) child.kill();
    await exit;
    await fs.rm(data, { force: true, recursive: true, maxRetries: 12, retryDelay: 200 });
  }
}
module.exports = { verifySettings };
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
