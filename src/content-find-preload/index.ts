import { contextBridge, ipcRenderer } from 'electron';
import { readContentFindAction, readContentFindState, type ContentFindPopupAPI, type ContentFindState } from '../shared/content-find.ts';

const api: ContentFindPopupAPI = {
  state: async () => { const value = await ipcRenderer.invoke('content-find:state'); return value ? readContentFindState(value) : undefined; },
  act: value => ipcRenderer.invoke('content-find:action', readContentFindAction(value)),
  onState: listener => {
    const callback = (_event: unknown, state: ContentFindState) => listener(readContentFindState(state));
    ipcRenderer.on('content-find:state', callback);
    return () => ipcRenderer.removeListener('content-find:state', callback);
  },
  onFocus: listener => {
    const callback = () => listener();
    ipcRenderer.on('content-find:focus', callback);
    return () => ipcRenderer.removeListener('content-find:focus', callback);
  },
};
contextBridge.exposeInMainWorld('dshContentFind', Object.freeze(api));
