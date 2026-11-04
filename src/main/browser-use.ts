import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import type { BrowserUseConfig, BrowserUseMode, BrowserUseState } from '../shared/browser-use.ts';
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
  if (platform === 'linux') return [
    { name: '龙芯浏览器', path: '/opt/apps/lbrowser/lbrowser' },
    { name: '龙芯浏览器', path: '/usr/bin/lbrowser' },
    { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
    { name: 'Google Chrome', path: '/opt/google/chrome/chrome' },
    { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
  ];
  return [];
}

export function browserProfileRoot(browser: string, platform: string, home: string, env: NodeJS.ProcessEnv): string {
  const edge = browser === 'Microsoft Edge';
  if (platform === 'darwin') return posix.join(home, 'Library/Application Support', edge ? 'Microsoft Edge' : 'Google/Chrome');
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData/Local'), edge ? 'Microsoft/Edge/User Data' : 'Google/Chrome/User Data');
  if (platform === 'linux') return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), browser === '龙芯浏览器' ? 'lbrowser' : edge ? 'microsoft-edge' : 'google-chrome');
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
  throw new Error(process.platform === 'linux' ? '未找到龙芯浏览器、Chrome 或 Edge，请安装浏览器后重试。' : '未找到可用的 Chrome 或 Edge，请安装浏览器后重试。');
}

export function browserUseMode(platform: string, arch: string): BrowserUseMode {
  return platform === 'linux' && arch === 'loong64' ? 'attach' : 'extension';
}

export class DesktopBrowserUse {
  state: BrowserUseState = { enabled: false, phase: 'disabled' };
  private pending: Promise<unknown> = Promise.resolve();
  private configure: (config: BrowserUseConfig) => Promise<void>;
  private publish: (state: BrowserUseState) => void;
  private find: typeof findBrowser;
  private extensionToken?: string;
  private credentials?: BrowserUseCredentials;
  private mode: BrowserUseMode;
  constructor(
    configure: (config: BrowserUseConfig) => Promise<void>,
    publish: (state: BrowserUseState) => void,
    find = findBrowser,
    credentials?: BrowserUseCredentials,
    mode: BrowserUseMode = browserUseMode(process.platform, process.arch),
  ) {
    this.configure = configure; this.publish = publish; this.find = find; this.credentials = credentials; this.mode = mode;
    this.state.mode = mode;
    if (mode === 'attach') this.state.cdpEndpoint = 'http://127.0.0.1:9222';
  }
  private update(state: BrowserUseState) { this.state = state; this.publish({ ...state }); }
  async restoreCredentials(): Promise<void> {
    if (!this.credentials || this.mode === 'attach') return;
    try {
      this.extensionToken = await this.credentials.load();
      this.update({ ...this.state, extensionTokenConfigured: Boolean(this.extensionToken), restartRequired: false });
    } catch (error) {
      this.update({ ...this.state, credentialError: error instanceof Error ? error.message : '自动连接凭据无法读取。' });
    }
  }
  saveExtensionToken(value: unknown): Promise<BrowserUseState> {
    if (this.mode === 'attach') return Promise.reject(new Error('当前使用本机 CDP 接管，不需要扩展连接令牌。'));
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
        await this.configure(!browser ? { enabled: false } : this.mode === 'attach'
          ? { enabled: true, cdpEndpoint: this.state.cdpEndpoint! }
          : { enabled: true, executablePath: browser.path, userDataDir: browser.userDataDir, ...(this.extensionToken ? { extensionToken: this.extensionToken } : {}) });
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
