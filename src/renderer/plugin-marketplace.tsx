import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { BrowserContext } from './sidebar-browser.tsx';
import type { MarketplaceRequest, MarketplaceResult, MarketplaceRpcResult } from '../shared/plugin-marketplace.ts';
import './plugin-marketplace.css';

export interface MarketplaceConnection {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }> };
}
interface MarketplaceContext {
  slots: BrowserContext['slots'];
  get(name: 'connection'): MarketplaceConnection;
}
interface MarketplaceProps {
  packages: readonly { name: string; version?: string; enabled: boolean; error?: unknown }[];
  busy: readonly string[];
  ready: boolean;
  installBusy: boolean;
  onInstall(spec?: string): void;
  onSetEnabled(name: string, enabled: boolean): void;
  search(request: MarketplaceRequest, signal: AbortSignal): Promise<MarketplaceRpcResult>;
}

/** Discovery owns no mutation: every install and enable goes through the official page face. */
function PluginMarketplace({ packages, busy, ready, installBusy, onInstall, onSetEnabled, search }: MarketplaceProps) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState<MarketplaceResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [page, setPage] = useState(0);
  const active = useRef<AbortController>();
  const load = useCallback((text: string, nextPage: number) => {
    active.current?.abort();
    const abort = new AbortController();
    active.current = abort;
    setLoading(true); setError(undefined); setResult(undefined); setSubmitted(text); setPage(nextPage);
    void search({ query: text, page: nextPage }, abort.signal).then(response => {
      if (abort.signal.aborted || active.current !== abort) return;
      if (response.ok) setResult(response.value);
      else setError(response.error.message || '插件市场暂时不可用，请重试。');
    }).catch(reason => {
      if (!abort.signal.aborted && active.current === abort) setError(reason instanceof Error ? reason.message : '插件市场暂时不可用，请重试。');
    }).finally(() => {
      if (!abort.signal.aborted && active.current === abort) setLoading(false);
    });
  }, [search]);
  useEffect(() => { load('', 0); return () => active.current?.abort(); }, [load]);
  const submit = (event: FormEvent) => { event.preventDefault(); load(query.trim(), 0); };

  return <div className="desktop-marketplace" data-plugin-marketplace>
    <header className="desktop-marketplace-heading"><div><h1>插件市场</h1><p>搜索 npm 上的 DSH 社区插件，并安装到当前配置。</p></div><button disabled={!ready || installBusy} onClick={() => onInstall()}>手动添加</button></header>
    <form className="desktop-marketplace-search" onSubmit={submit}><input aria-label="搜索插件市场" placeholder="搜索名称、功能或关键词" maxLength={100} value={query} onChange={event => setQuery(event.target.value)} /><button type="submit">搜索</button></form>
    <p className="desktop-marketplace-note">来源：npm · 已核验插件声明，兼容性尚未验证。安装前可在 npm 查看作者与源码。</p>
    <div aria-live="polite" aria-busy={loading}>
      {loading && <p role="status">正在搜索插件市场…</p>}
      {error && <div className="desktop-marketplace-error" role="alert"><span>{error}</span><button onClick={() => load(submitted, page)}>重试</button></div>}
      {result?.warning && <p className="desktop-marketplace-note" role="status">{result.warning}</p>}
      {result && result.items.length === 0 && <p role="status">{result.hasMore ? '本页暂无核验通过的插件，可以继续下一页。' : '没有找到匹配的插件。试试其他关键词，或使用“手动添加”。'}</p>}
      <div className="desktop-marketplace-results">{result?.items.map(item => {
        const local = packages.find(pkg => pkg.name === item.name);
        const state = local ? local.enabled ? 'enabled' : 'disabled' : 'available';
        const pending = busy.includes(item.name);
        return <article className="desktop-marketplace-card" key={item.name} data-marketplace-package={item.name} data-marketplace-state={state}>
          <div className="desktop-marketplace-card-heading"><div><h2>{item.name}</h2><span className="desktop-marketplace-version">{local ? `已安装 ${local.version ?? ''} · 市场 ${item.version}` : `v${item.version}`}</span></div><button disabled={!ready || installBusy || pending || state === 'enabled'} onClick={() => local ? onSetEnabled(item.name, true) : onInstall(`${item.name}@${item.version}`)}>{pending ? '处理中…' : state === 'enabled' ? '已启用' : state === 'disabled' ? '启用' : '安装'}</button></div>
          <p>{item.description || '发布者未提供描述。'}</p>
          <div className="desktop-marketplace-meta"><span>{item.author ? `发布者：${item.author}` : '社区插件'}</span><button className="desktop-marketplace-link" onClick={() => { void window.dshDesktop?.openExternal(item.npmUrl); }}>在 npm 查看 ↗</button>{(item.githubUrl || item.repository) && <button className="desktop-marketplace-link" data-marketplace-repository onClick={() => { void window.dshDesktop?.openExternal((item.githubUrl || item.repository)!); }}>{item.githubUrl ? 'GitHub 仓库 ↗' : '源码仓库 ↗'}</button>}</div>
          <p className="desktop-marketplace-downloads" data-marketplace-downloads>{item.downloads ? <>近月下载 {item.downloads.count.toLocaleString('zh-CN')} 次 <span>（{item.downloads.start} — {item.downloads.end}，npm 全版本）</span></> : '近月下载：暂不可用'}<span> · 下载量不代表安全性</span></p>
          {Boolean(local?.error) && <p className="desktop-marketplace-error">插件加载异常，可在侧栏“插件”中查看详情。</p>}
        </article>;
      })}</div>
    </div>
    {result && (page > 0 || result.hasMore) && <nav className="desktop-marketplace-pagination" aria-label="插件市场分页"><button disabled={page === 0 || loading} onClick={() => load(submitted, page - 1)}>上一页</button><span>第 {page + 1} 页</span><button disabled={!result.hasMore || loading} onClick={() => load(submitted, page + 1)}>下一页</button></nav>}
    <p className="desktop-marketplace-note">已安装插件的配置与卸载可在侧栏“插件”中管理。</p>
  </div>;
}

export function installPluginMarketplace(ctx: MarketplaceContext): void {
  const connection = ctx.get('connection');
  const search = (request: MarketplaceRequest, signal: AbortSignal) => connection.rpc.call('/desktop-marketplace', 'search', { args: request }, signal) as Promise<MarketplaceRpcResult>;
  ctx.slots.inject('plugins.marketplace', () => ctx.slots.register({ name: 'plugins.marketplace', id: 'desktop-marketplace', inject: () => ({ search }) }, PluginMarketplace));
}
