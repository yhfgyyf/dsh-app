import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/desktop-api.ts';
import { isDesktopCommand, externalWebUrl } from '../shared/desktop-api.ts';
import { validBrowserId, type BrowserState, type BrowserFindResult } from '../shared/sidebar-browser.ts';
import type { UpdateState } from '../shared/updates.ts';
import type { ComputerState } from '../shared/computer-use.ts';
import type { BrowserUseState } from '../shared/browser-use.ts';
import { readContentFindAction, readContentFindId, readContentFindState } from '../shared/content-find.ts';

const api: DesktopAPI = {
  exportRemoteDiagnostics: () => ipcRenderer.invoke('desktop:remote-diagnostics'),
  getRemoteState: () => ipcRenderer.invoke('desktop:remote-state'),
  remoteAction: action => ipcRenderer.invoke('desktop:remote-action', action),
  onRemoteState: listener => {
    const callback = (_event: unknown, state: import('../shared/remote-access.ts').RemoteState) => listener(state);
    ipcRenderer.on('desktop:remote-state', callback);
    return () => ipcRenderer.removeListener('desktop:remote-state', callback);
  },
  getBrowserUseState: () => ipcRenderer.invoke('desktop:browser-use-state'),
  setBrowserUseEnabled: enabled => ipcRenderer.invoke('desktop:browser-use-enabled', enabled),
  saveBrowserUseToken: token => ipcRenderer.invoke('desktop:browser-use-token', token),
  onBrowserUseState: listener => {
    const callback = (_event: unknown, state: BrowserUseState) => listener(state);
    ipcRenderer.on('desktop:browser-use-state', callback);
    return () => ipcRenderer.removeListener('desktop:browser-use-state', callback);
  },
  getComputerState: () => ipcRenderer.invoke('desktop:computer-state'),
  setComputerEnabled: enabled => ipcRenderer.invoke('desktop:computer-enabled', enabled),
  stopComputerUse: () => ipcRenderer.invoke('desktop:computer-stop'),
  showComputerPreview: () => ipcRenderer.invoke('desktop:computer-preview'),
  onComputerState: listener => {
    const callback = (_event: unknown, state: ComputerState) => listener(state);
    ipcRenderer.on('desktop:computer-state', callback);
    return () => ipcRenderer.removeListener('desktop:computer-state', callback);
  },
  getUpdateState: () => ipcRenderer.invoke('desktop:update-state'),
  setUpdateSchedule: (schedule) => ipcRenderer.invoke('desktop:update-schedule', schedule),
  checkForUpdates: () => ipcRenderer.invoke('desktop:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install'),
  onUpdateState: (listener) => {
    const callback = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on('desktop:update-state', callback);
    return () => ipcRenderer.removeListener('desktop:update-state', callback);
  },
  getInfo: () => ipcRenderer.invoke('desktop:info'),
  getBoot: () => ipcRenderer.invoke('desktop:boot'),
  connect: (input) => ipcRenderer.invoke('desktop:connect', input),
  showConnection: () => ipcRenderer.invoke('desktop:connection'),
  reconnect: () => ipcRenderer.invoke('desktop:reconnect'),
  ready: () => ipcRenderer.invoke('desktop:ready'),
  setColorScheme: (scheme) => ipcRenderer.invoke('desktop:color-scheme', scheme),
  openExternal: (url) => ipcRenderer.invoke('desktop:external', url),
  openLocal: (request) => ipcRenderer.invoke('desktop:local-open', request),
  browserOpen: (id, target, navigation) => ipcRenderer.invoke('desktop:browser-open', id, target, navigation),
  browserBounds: (id, bounds) => ipcRenderer.invoke('desktop:browser-bounds', id, bounds),
  browserNavigate: (id, url) => ipcRenderer.invoke('desktop:browser-navigate', id, url),
  browserAction: (id, action) => ipcRenderer.invoke('desktop:browser-action', id, action),
  browserClose: (id) => ipcRenderer.invoke('desktop:browser-close', id),
  browserFind: (id, query, forward) => ipcRenderer.invoke('desktop:browser-find', id, query, forward),
  showContentFind: id => ipcRenderer.invoke('desktop:content-find-show', readContentFindId(id)),
  updateContentFind: state => ipcRenderer.invoke('desktop:content-find-update', readContentFindState(state)),
  closeContentFind: id => ipcRenderer.invoke('desktop:content-find-close', readContentFindId(id)),
  onContentFindAction: listener => {
    const callback = (_event: unknown, action: unknown) => listener(readContentFindAction(action));
    ipcRenderer.on('desktop:content-find-action', callback);
    return () => ipcRenderer.removeListener('desktop:content-find-action', callback);
  },
  onBrowserFindResult: listener => {
    const callback = (_event: unknown, result: BrowserFindResult) => listener(result);
    ipcRenderer.on('desktop:browser-find-result', callback);
    return () => ipcRenderer.removeListener('desktop:browser-find-result', callback);
  },
  onOpenLink: (listener) => {
    const callback = (_event: unknown, value: unknown) => { const url = externalWebUrl(value); if (url) listener(url); };
    ipcRenderer.on('desktop:open-link', callback);
    return () => ipcRenderer.removeListener('desktop:open-link', callback);
  },
  onBrowserState: (listener) => {
    const callback = (_event: unknown, state: BrowserState) => listener(state);
    ipcRenderer.on('desktop:browser-state', callback);
    return () => ipcRenderer.removeListener('desktop:browser-state', callback);
  },
  onCommand: (listener) => {
    const callback = (_event: unknown, command: unknown, browserId: unknown) => {
      if (isDesktopCommand(command)) listener(command, validBrowserId(browserId) ? browserId : undefined);
    };
    ipcRenderer.on('desktop:command', callback);
    return () => ipcRenderer.removeListener('desktop:command', callback);
  },
};

contextBridge.exposeInMainWorld('dshDesktop', Object.freeze(api));
