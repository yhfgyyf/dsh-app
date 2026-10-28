import type { RemoteAction, RemoteState } from './remote-access.ts';
import type { BrowserAction, BrowserState, BrowserTarget, BrowserFindResult } from './sidebar-browser.ts';
import type { UpdateSchedule, UpdateState } from './updates.ts';
import type { LocalOpenRequest } from './local-open.ts';
import type { ComputerState } from './computer-use.ts';
import type { BrowserUseState } from './browser-use.ts';
import type { ContentFindAction, ContentFindState } from './content-find.ts';

export type DesktopCommand = 'new-session' | 'search' | 'find-content' | 'settings' | 'sidebar' | 'details';

export type DesktopInfo = {
  name: string;
  version: string;
  endpoint: string;
  connected: boolean;
  connecting: boolean;
  error?: string;
  zoomFactor: number;
  platform: string;
  arch: string;
};

export interface DesktopAPI {
  exportRemoteDiagnostics(): Promise<string | undefined>;
  getRemoteState(): Promise<RemoteState>;
  remoteAction(action: RemoteAction): Promise<RemoteState>;
  onRemoteState(listener: (state: RemoteState) => void): () => void;
  getBrowserUseState(): Promise<BrowserUseState>;
  setBrowserUseEnabled(enabled: boolean): Promise<BrowserUseState>;
  saveBrowserUseToken(token: string | null): Promise<BrowserUseState>;
  onBrowserUseState(listener: (state: BrowserUseState) => void): () => void;
  getComputerState(): Promise<ComputerState>;
  setComputerEnabled(enabled: boolean): Promise<ComputerState>;
  stopComputerUse(): Promise<void>;
  showComputerPreview(): Promise<void>;
  onComputerState(listener: (state: ComputerState) => void): () => void;
  getUpdateState(): Promise<UpdateState>;
  setUpdateSchedule(schedule: UpdateSchedule): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  getInfo(): Promise<DesktopInfo>;
  getBoot(): Promise<unknown>;
  connect(input: string): Promise<{ ok: boolean; error?: string }>;
  showConnection(): Promise<void>;
  reconnect(): Promise<{ ok: boolean; error?: string }>;
  ready(): Promise<void>;
  setColorScheme(scheme: 'light' | 'dark'): Promise<void>;
  openExternal(url: string): Promise<void>;
  openLocal(request: LocalOpenRequest): Promise<void>;
  browserOpen(id: string, target: BrowserTarget, navigation: string): Promise<BrowserState>;
  browserBounds(id: string, bounds: unknown): Promise<void>;
  browserNavigate(id: string, url: string): Promise<void>;
  browserAction(id: string, action: BrowserAction): Promise<void>;
  browserClose(id: string): Promise<void>;
  browserFind(id: string, query: string, forward?: boolean): Promise<void>;
  onBrowserFindResult(listener: (result: BrowserFindResult) => void): () => void;
  showContentFind(id: string): Promise<void>;
  updateContentFind(state: ContentFindState): Promise<void>;
  closeContentFind(id: string): Promise<void>;
  onContentFindAction(listener: (action: ContentFindAction) => void): () => void;
  onOpenLink(listener: (url: string) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onCommand(listener: (command: DesktopCommand, browserId?: string) => void): () => void;
}

declare global {
  interface Window {
    dshDesktop?: DesktopAPI;
    __DSH_BOOT__?: unknown;
  }
}

export function isDesktopCommand(value: unknown): value is DesktopCommand {
  return ['new-session', 'search', 'find-content', 'settings', 'sidebar', 'details'].includes(value as string);
}

export function externalWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
