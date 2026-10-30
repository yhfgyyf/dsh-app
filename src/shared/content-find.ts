export type ContentFindState = { id: string; query: string; matches: number; active: number; limited: boolean; error: string };
export type ContentFindAction = { id: string } & ({ type: 'query'; query: string } | { type: 'navigate'; forward: boolean } | { type: 'close' });

export function readContentFindId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('查找窗口标识无效。');
  return value;
}

export function readContentFindState(value: unknown): ContentFindState {
  if (!value || typeof value !== 'object') throw new Error('查找状态无效。');
  const state = value as ContentFindState;
  const id = readContentFindId(state.id);
  if (typeof state.query !== 'string' || state.query.length > 4096 || !Number.isSafeInteger(state.matches) || state.matches < 0
    || !Number.isSafeInteger(state.active) || state.active < 0 || state.active > state.matches || typeof state.limited !== 'boolean'
    || typeof state.error !== 'string' || state.error.length > 4096) throw new Error('查找状态无效。');
  return { id, query: state.query, matches: state.matches, active: state.active, limited: state.limited, error: state.error };
}

export function readContentFindAction(value: unknown): ContentFindAction {
  if (!value || typeof value !== 'object') throw new Error('查找操作无效。');
  const action = value as ContentFindAction;
  const id = readContentFindId(action.id);
  if (action.type === 'close') return { id, type: 'close' };
  if (action.type === 'query' && typeof action.query === 'string' && action.query.length <= 4096) return { id, type: 'query', query: action.query };
  if (action.type === 'navigate' && typeof action.forward === 'boolean') return { id, type: 'navigate', forward: action.forward };
  throw new Error('查找操作无效。');
}

export interface ContentFindPopupAPI {
  state(): Promise<ContentFindState | undefined>;
  act(action: ContentFindAction): Promise<void>;
  onState(listener: (state: ContentFindState) => void): () => void;
  onFocus(listener: () => void): () => void;
}

declare global { interface Window { dshContentFind: ContentFindPopupAPI } }
