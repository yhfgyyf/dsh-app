import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, win32 } from 'node:path';
import { homedir } from 'node:os';
import type { BrowserUseConfig, BrowserUseState } from '../shared/browser-use.ts';

export function browserCandidates(platform: string, home: string, env: NodeJS.ProcessEnv): { name: string; path: string }[] {
  if (platform === 'darwin') return ['/Applications', join(home, 'Applications')].flatMap(directory => [
    { name: 'Google Chrome', path: join(directory, 'Google Chrome.app/Contents/MacOS/Google Chrome') },
    { name: 'Microsoft Edge', path: join(directory, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge') },
  ]);
  if (platform === 'win32') return [...new Set([env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((value): value is string => Boolean(value)))].flatMap(directory => [
    { name: 'Microsoft Edge', path: win32.join(directory, 'Microsoft/Edge/Application/msedge.exe') },
    { name: 'Google Chrome', path: win32.join(directory, 'Google/Chrome/Application/chrome.exe') },
  ]);
  return [];
}

async function findBrowser() {
  for (const browser of browserCandidates(process.platform, homedir(), process.env)) {
    try { await access(browser.path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return browser; }
    catch { /* Try the next supported browser installation. */ }
  }
  throw new Error('未找到可用的 Chrome 或 Edge，请安装浏览器后重试。');
}

export class DesktopBrowserUse {
  state: BrowserUseState = { enabled: false, phase: 'disabled' };
  private pending: Promise<unknown> = Promise.resolve();
  private configure: (config: BrowserUseConfig) => Promise<void>;
  private publish: (state: BrowserUseState) => void;
  private find: typeof findBrowser;
  constructor(
    configure: (config: BrowserUseConfig) => Promise<void>,
    publish: (state: BrowserUseState) => void,
    find = findBrowser,
  ) { this.configure = configure; this.publish = publish; this.find = find; }
  private update(state: BrowserUseState) { this.state = state; this.publish({ ...state }); }
  disconnected() { this.update({ enabled: false, phase: 'disabled' }); }
  setEnabled(enabled: boolean): Promise<BrowserUseState> {
    const operation = this.pending.then(async () => {
      if (this.state.enabled === enabled && this.state.phase !== 'error') return { ...this.state };
      const previous = this.state;
      this.update({ ...previous, phase: enabled ? 'starting' : 'stopping', error: undefined });
      try {
        const browser = enabled ? await this.find() : undefined;
        await this.configure(browser ? { enabled: true, executablePath: browser.path } : { enabled: false });
        this.update({ enabled, phase: enabled ? 'ready' : 'disabled', ...(browser ? { browser: browser.name } : {}) });
      } catch (error) {
        this.update({ ...previous, phase: 'error', error: error instanceof Error ? error.message : '浏览器操作开关设置失败。' });
      }
      return { ...this.state };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
