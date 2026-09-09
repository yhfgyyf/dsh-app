import type { BrowserAction, BrowserState, BrowserTarget } from './sidebar-browser.ts';
import type { UpdateSchedule, UpdateState } from './updates.ts';

export type DesktopCommand = 'new-session' | 'search' | 'settings' | 'sidebar' | 'details';

export type DesktopInfo = {
  name: string;
  version: string;
  endpoint: string;
  connected: boolean;
  connecting: boolean;
  error?: string;
  zoomFactor: number;
  platform: string;
};

export interface DesktopAPI {
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
  browserOpen(id: string, target: BrowserTarget, navigation: string): Promise<BrowserState>;
  browserBounds(id: string, bounds: unknown): Promise<void>;
  browserNavigate(id: string, url: string): Promise<void>;
  browserAction(id: string, action: BrowserAction): Promise<void>;
  browserClose(id: string): Promise<void>;
  onOpenLink(listener: (url: string) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
}

declare global {
  interface Window {
    dshDesktop?: DesktopAPI;
    __DSH_BOOT__?: unknown;
  }
}

export function isDesktopCommand(value: unknown): value is DesktopCommand {
  return ['new-session', 'search', 'settings', 'sidebar', 'details'].includes(value as string);
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
