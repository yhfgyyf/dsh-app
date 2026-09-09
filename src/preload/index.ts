import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/desktop-api.ts';
import { isDesktopCommand, externalWebUrl } from '../shared/desktop-api.ts';
import type { BrowserState } from '../shared/sidebar-browser.ts';
import type { UpdateState } from '../shared/updates.ts';
import type { ComputerState } from '../shared/computer-use.ts';

const api: DesktopAPI = {
  getComputerState: () => ipcRenderer.invoke('desktop:computer-state'),
  requestComputerPermissions: () => ipcRenderer.invoke('desktop:computer-permissions'),
  stopComputerUse: () => ipcRenderer.invoke('desktop:computer-stop'),
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
    const callback = (_event: unknown, command: unknown) => {
      if (isDesktopCommand(command)) listener(command);
    };
    ipcRenderer.on('desktop:command', callback);
    return () => ipcRenderer.removeListener('desktop:command', callback);
  },
};

contextBridge.exposeInMainWorld('dshDesktop', Object.freeze(api));
