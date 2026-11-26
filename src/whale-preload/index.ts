import { contextBridge, ipcRenderer } from 'electron';

const send = (action: string, ...args: unknown[]) => ipcRenderer.send('whale:input', action, ...args);
function listen(channel: string, fn: (value: unknown) => void) {
  const receive = (_: Electron.IpcRendererEvent, value: unknown) => fn(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.off(channel, receive);
}
contextBridge.exposeInMainWorld('whaleHost', {
  ready: () => send('ready'),
  onState: (fn: (value: unknown) => void) => listen('whale:state', fn),
  onNotice: (fn: (value: unknown) => void) => listen('whale:notice', fn),
  mask: (width: number, height: number, rows: number[]) => send('mask', width, height, rows),
  water: (value: boolean) => send('water', value),
  saveHidden: (value: boolean) => send('hidden', value),
  bodyGestures: true,
  down: (target?: string) => send('down', target), up: () => ipcRenderer.invoke('whale:up'), cancel: () => send('cancel'),
  dictate: (id: string, action: string) => send('dictate', id, action),
});
