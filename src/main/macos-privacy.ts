import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** Called only by the user's explicit recovery-button click, never on startup. */
export async function resetDshComputerPermissions(run: (command: string, args: string[]) => Promise<unknown> = execute) {
  for (const service of ['Accessibility', 'ScreenCapture']) await run('/usr/bin/tccutil', ['reset', service, 'io.dsh.desktop']);
}
