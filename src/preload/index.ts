import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/desktop-api.ts';
import { isDesktopCommand } from '../shared/desktop-api.ts';

const api: DesktopAPI = {
  getInfo: () => ipcRenderer.invoke('desktop:info'),
  getBoot: () => ipcRenderer.invoke('desktop:boot'),
  connect: (input) => ipcRenderer.invoke('desktop:connect', input),
  showConnection: () => ipcRenderer.invoke('desktop:connection'),
  reconnect: () => ipcRenderer.invoke('desktop:reconnect'),
  ready: () => ipcRenderer.invoke('desktop:ready'),
  setColorScheme: (scheme) => ipcRenderer.invoke('desktop:color-scheme', scheme),
  openExternal: (url) => ipcRenderer.invoke('desktop:external', url),
  onCommand: (listener) => {
    const callback = (_event: unknown, command: unknown) => {
      if (isDesktopCommand(command)) listener(command);
    };
    ipcRenderer.on('desktop:command', callback);
    return () => ipcRenderer.removeListener('desktop:command', callback);
  },
};

contextBridge.exposeInMainWorld('dshDesktop', Object.freeze(api));
