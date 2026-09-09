import { previewFileOf } from './sidebar-browser.ts';

export type LocalOpenTarget = { address: string; sessionId: string; cwd?: string } | { path: string };
export type LocalOpenAction = 'default' | 'choose-app' | 'reveal' | 'pick-file' | 'pick-directory';
export type LocalOpenRequest = { action: LocalOpenAction; target?: LocalOpenTarget; cwd?: string };

/** Resolve only local file resources from the current session, never web/terminal tabs. */
export function currentLocalTarget(address: string | undefined, sessionId: string, cwd?: string): LocalOpenTarget | undefined {
  return address && previewFileOf(address, sessionId) ? { address, sessionId, cwd } : undefined;
}
