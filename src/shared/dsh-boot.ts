export const DESKTOP_PLUGIN_ID = 'dsh-desktop-shell';
export const DESKTOP_ASSET_PREFIX = '/__dsh_desktop__/';

export type BootEntry = {
  id: string;
  url: string;
  rev: string;
  inject?: string[];
  external?: string[];
  immediately?: boolean;
  [key: string]: unknown;
};

export type BootBatch = {
  url: string;
  rev: string;
  phase: 'bootstrap' | 'application';
  entries: string[];
  [key: string]: unknown;
};

export type BootGraph = {
  rev: string;
  entries: BootEntry[];
  batches: BootBatch[];
  [key: string]: unknown;
};

export function assertBootGraph(value: unknown): asserts value is BootGraph {
  const fail = () => { throw new Error('DSH 启动清单不兼容，未修改现有插件。'); };
  if (typeof value !== 'object' || value === null) return fail();
  const graph = value as BootGraph;
  if (typeof graph.rev !== 'string' || !Array.isArray(graph.entries) || !Array.isArray(graph.batches)) return fail();
  const ids = new Set<string>();
  for (const entry of graph.entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.url !== 'string' || typeof entry.rev !== 'string' || ids.has(entry.id)) return fail();
    ids.add(entry.id);
    for (const key of ['inject', 'external'] as const) {
      if (entry[key] !== undefined && (!Array.isArray(entry[key]) || !entry[key]!.every((item) => typeof item === 'string'))) return fail();
    }
    if (entry.immediately !== undefined && typeof entry.immediately !== 'boolean') return fail();
  }
  const assigned = new Set<string>();
  const urls = new Set<string>();
  for (const batch of graph.batches) {
    if (!batch || typeof batch.url !== 'string' || typeof batch.rev !== 'string' || !['bootstrap', 'application'].includes(batch.phase) || urls.has(batch.url)) return fail();
    if (!Array.isArray(batch.entries) || batch.entries.length === 0) return fail();
    urls.add(batch.url);
    for (const id of batch.entries) {
      if (typeof id !== 'string' || !ids.has(id) || assigned.has(id)) return fail();
      assigned.add(id);
    }
  }
  if (assigned.size !== ids.size) return fail();
}

/** Add one application plugin without changing the server's modules, batches, or revisions. */
export function withDesktopPlugin(value: unknown, revision: string): BootGraph {
  assertBootGraph(value);
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(revision)) throw new Error('桌面插件版本无效。');
  if (value.entries.some((entry) => entry.id === DESKTOP_PLUGIN_ID)) throw new Error('桌面插件已加载。');
  const required = ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-theme', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-sidebar-right'];
  if (required.some((id) => !value.entries.some((entry) => entry.id === id))) {
    throw new Error('此 DSH 服务缺少桌面布局所需的前端插件。');
  }
  const url = `${DESKTOP_ASSET_PREFIX}plugin.js?rev=${revision}`;
  if (value.batches.some((batch) => batch.url === url)) throw new Error('桌面插件资源地址冲突。');
  const result: BootGraph = {
    ...value,
    entries: [...value.entries, { id: DESKTOP_PLUGIN_ID, url, rev: revision, inject: required, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] }],
    batches: [...value.batches, { url, rev: revision, phase: 'application', entries: [DESKTOP_PLUGIN_ID] }],
  };
  assertBootGraph(result);
  return result;
}
