import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import type { BrowserUseConfig, BrowserUseState } from '../shared/browser-use.ts';
import { parseExtensionToken, type BrowserUseCredentials } from './browser-use-credentials.ts';

export function browserCandidates(platform: string, home: string, env: NodeJS.ProcessEnv): { name: string; path: string }[] {
  if (platform === 'darwin') return ['/Applications', posix.join(home, 'Applications')].flatMap(directory => [
    { name: 'Google Chrome', path: posix.join(directory, 'Google Chrome.app/Contents/MacOS/Google Chrome') },
    { name: 'Microsoft Edge', path: posix.join(directory, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge') },
  ]);
  if (platform === 'win32') return [...new Set([env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((value): value is string => Boolean(value)))].flatMap(directory => [
    { name: 'Google Chrome', path: win32.join(directory, 'Google/Chrome/Application/chrome.exe') },
    { name: 'Microsoft Edge', path: win32.join(directory, 'Microsoft/Edge/Application/msedge.exe') },
  ]);
  return [];
}

export function browserProfileRoot(browser: string, platform: string, home: string, env: NodeJS.ProcessEnv): string {
  const edge = browser === 'Microsoft Edge';
  if (platform === 'darwin') return posix.join(home, 'Library/Application Support', edge ? 'Microsoft Edge' : 'Google/Chrome');
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData/Local'), edge ? 'Microsoft/Edge/User Data' : 'Google/Chrome/User Data');
  throw new Error('当前系统不支持浏览器操作。');
}

async function findBrowser() {
  for (const browser of browserCandidates(process.platform, homedir(), process.env)) {
    try {
      await access(browser.path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return { ...browser, userDataDir: browserProfileRoot(browser.name, process.platform, homedir(), process.env) };
    }
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
  private extensionToken?: string;
  private credentials?: BrowserUseCredentials;
  constructor(
    configure: (config: BrowserUseConfig) => Promise<void>,
    publish: (state: BrowserUseState) => void,
    find = findBrowser,
    credentials?: BrowserUseCredentials,
  ) { this.configure = configure; this.publish = publish; this.find = find; this.credentials = credentials; }
  private update(state: BrowserUseState) { this.state = state; this.publish({ ...state }); }
  async restoreCredentials(): Promise<void> {
    if (!this.credentials) return;
    try {
      this.extensionToken = await this.credentials.load();
      this.update({ ...this.state, extensionTokenConfigured: Boolean(this.extensionToken), restartRequired: false });
    } catch (error) {
      this.update({ ...this.state, credentialError: error instanceof Error ? error.message : '自动连接凭据无法读取。' });
    }
  }
  saveExtensionToken(value: unknown): Promise<BrowserUseState> {
    const token = parseExtensionToken(value);
    const operation = this.pending.then(async () => {
      if (!this.credentials) throw new Error('自动连接凭据存储不可用。');
      await this.credentials.save(token);
      // Apply on restart: replacing a live MCP connection can interrupt a user's turn.
      this.update({ ...this.state, extensionTokenConfigured: Boolean(token), restartRequired: token !== this.extensionToken, credentialError: undefined });
      return { ...this.state };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  disconnected() { this.update({ ...this.state, enabled: false, phase: 'disabled' }); }
  setEnabled(enabled: boolean): Promise<BrowserUseState> {
    const operation = this.pending.then(async () => {
      if (this.state.enabled === enabled && this.state.phase !== 'error') return { ...this.state };
      const previous = this.state;
      this.update({ ...previous, phase: enabled ? 'starting' : 'stopping', error: undefined });
      try {
        const browser = enabled ? await this.find() : undefined;
        await this.configure(browser ? { enabled: true, executablePath: browser.path, userDataDir: browser.userDataDir, ...(this.extensionToken ? { extensionToken: this.extensionToken } : {}) } : { enabled: false });
        this.update({ ...this.state, enabled, phase: enabled ? 'ready' : 'disabled', browser: browser?.name, error: undefined });
      } catch (error) {
        this.update({ ...previous, phase: 'error', error: error instanceof Error ? error.message : '浏览器操作开关设置失败。' });
      }
      return { ...this.state };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
