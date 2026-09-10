import { contextBridge, ipcRenderer } from 'electron';
import type { ComputerState } from '../shared/computer-use.ts';

contextBridge.exposeInMainWorld('computerPreview', Object.freeze({
  state: () => ipcRenderer.invoke('computer-preview:state'),
  frame: () => ipcRenderer.invoke('computer-preview:frame'),
  stop: () => ipcRenderer.invoke('computer-preview:stop'),
  returnToApp: () => ipcRenderer.invoke('computer-preview:return'),
  hide: () => ipcRenderer.invoke('computer-preview:hide'),
  onState: (listener: (state: ComputerState) => void) => {
    const callback = (_event: unknown, state: ComputerState) => listener(state);
    ipcRenderer.on('computer-preview:state', callback);
    return () => ipcRenderer.removeListener('computer-preview:state', callback);
  },
}));
