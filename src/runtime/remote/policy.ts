const reads = new Set([
  'session/list', 'session/search', 'session/page', 'session/modelCatalog', 'session/attachment',
  'session/canOpenWorkspacePath', 'subagents/list', 'agentPresets/list', 'agentPresets/read',
  'llm/listProviders', 'permissionPresets/catalog', 'skills/list', 'messageFeedback/list',
]);
const controls = new Set([
  'directoryPicker/list', 'workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'officeToPdf/render',
  'terminal/environment', 'terminal/shells', 'terminal/list', 'terminal/create', 'terminal/write', 'terminal/resize', 'terminal/rename', 'terminal/close',
  'speech/catalog', 'speech/prepare', 'speech/transcribe',
  'session/create', 'session/delete', 'session/prompt', 'session/rename', 'session/fork', 'session/cancel', 'session/updateQueue', 'session/selectModel',
  'session/uploadFileBinary', 'session/uploadFile', 'session/openWorkspacePath', 'subagents/prompt',
  'workspace/create', 'workspace/rename', 'workspace/delete', 'workspace/insertBefore', 'workspace/insertSessionBefore',
  'workspace/archiveSession', 'workspace/unarchiveSession', 'workspace/pinSession', 'workspace/unpinSession',
  'directoryPicker/createDirectory', 'job/kill', 'messageFeedback/put', 'messageFeedback/delete', '$events/result',
]);
const streams = new Set(['$events', 'session/follow', 'workspace/follow', 'session/control', 'job/list', 'job/follow']);
const controlStreams = new Set(['workspaceFiles/changes', 'terminal/follow', 'terminal/retain']);

/** A refused logical stream must not retire the other streams on the same socket. */
export class RemoteStreamDenied extends Error {
  readonly streamId: string;
  constructor(streamId: string) { super('forbidden_stream'); this.streamId = streamId; }
}

export function permittedPath(method: string, path: unknown, role: 'viewer' | 'control'): string {
  if (typeof path !== 'string' || path.length > 8192 || /[\u0000-\u0020\u007f\\#]/.test(path) || /[%]/.test(path.split('?')[0]) || !path.startsWith('/api/')) throw new Error('forbidden_path');
  const url = new URL(path, 'http://127.0.0.1');
  if (url.origin !== 'http://127.0.0.1' || url.pathname !== path.split('?')[0]) throw new Error('forbidden_path');
  const endpoint = url.pathname.slice(5);
  if (method === 'GET' && ['session.export', 'session/export'].includes(endpoint)) return path;
  if (method !== 'POST' || (!reads.has(endpoint) && !(role === 'control' && controls.has(endpoint)))) throw new Error('forbidden_operation');
  return path;
}

export function permittedMux(text: string, role: 'viewer' | 'control'): void {
  const m = JSON.parse(text);
  if (typeof m.streamId !== 'string' || m.streamId.length > 128) throw new Error('invalid_stream');
  if (m.type === 'cancel') return;
  if (m.type !== 'open') throw new Error('invalid_stream');
  if ((!streams.has(m.endpoint) && !(role === 'control' && controlStreams.has(m.endpoint))) || (role === 'viewer' && m.endpoint === 'session/control')) throw new RemoteStreamDenied(m.streamId);
  if (m.endpoint === '$events') {
    // Viewers receive notifications but must never become a waterfall responder.
    const events = m.payload?.args?.request?.events;
    if (role === 'viewer' && Array.isArray(events) && events.some((e: any) => typeof e === 'string' ? ['approval/request', 'user-questions/request'].includes(e) : e?.mode === 'waterfall')) throw new RemoteStreamDenied(m.streamId);
  }
}
