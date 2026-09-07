import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { DirectoryPicker } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-host-directory-picker')).href);

/** The same DSH directory capability, carried by the owning Electron window. */
export default class DesktopDirectoryPicker extends DirectoryPicker {
  private nativeCapability = { kind: 'native', pick: (signal: AbortSignal) => new Promise<string | null>((resolve, reject) => {
      if (signal.aborted || !process.connected) { reject(new Error('Directory selection cancelled.')); return; }
      const id = randomUUID();
      const cleanup = () => { process.off('message', receive); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new Error('Directory selection cancelled.')); };
      const receive = (value: any) => {
        if (value?.type !== 'folder-picked' || value.id !== id) return;
        cleanup();
        if (typeof value.path === 'string' || value.path === null) resolve(value.path);
        else reject(new Error('Invalid directory selection result.'));
      };
      process.on('message', receive);
      signal.addEventListener('abort', abort, { once: true });
      process.send!({ type: 'pick-folder', id });
    }) };
  capability() { return this.nativeCapability; }
}
