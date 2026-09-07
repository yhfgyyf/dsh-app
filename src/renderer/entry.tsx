import * as React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as Cordis from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import * as ClientStore from '@deepseek-ai/dsh-client-store';
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots';
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives';
import { withDesktopPlugin } from '../shared/dsh-boot.ts';
import '../shared/desktop-api.ts';

type Registration = { id: string; factory(require: (name: string) => unknown): any };
const target = window as unknown as { __ModuleLoader__: any };
const root = document.getElementById('root')!;
const status = ReactDomClient.createRoot(root);
function Startup({ error }: { error?: string }) {
  return <div className="desktop-startup"><strong>DSH Desktop</strong><p>{error ?? '正在加载会话、工具和设置…'}</p>{error && <button onClick={() => location.reload()}>重新加载</button>}</div>;
}
status.render(<Startup />);
let context: Cordis.Context | undefined;
async function bootDesktop() {
  const graph = withDesktopPlugin(await window.dshDesktop!.getBoot(), '0.1.0');
  const queue: Registration[] = [];
  const facade = { mode: 'queue', pendingQueue: queue, load(registration: Registration) { queue.push(registration); } };
  target.__ModuleLoader__ = facade;
  const loadScript = (url: string) => new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url; script.onload = () => resolve(); script.onerror = () => reject(new Error('无法加载 DSH 功能模块。'));
    document.head.append(script);
  });
  for (const batch of graph.batches.filter(batch => batch.phase === 'bootstrap')) await loadScript(batch.url);
  const index = queue.findIndex(row => row.id === '@deepseek-ai/dsh-client-modules');
  if (index < 0) throw new Error('DSH 模块加载器缺失。');
  const [registration] = queue.splice(index, 1);
  const exports = registration.factory(name => { throw new Error(`Unexpected bootstrap external: ${name}`); });
  const modules = exports.createClientModuleSystem(facade, { id: registration.id, exports }, { boot: graph, staticModules: {
    react: React, 'react/jsx-runtime': ReactJsxRuntime, 'react-dom': ReactDom, 'react-dom/client': ReactDomClient,
    '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-store': ClientStore,
    '@deepseek-ai/dsh-client-ui-slots': UiSlots, '@deepseek-ai/dsh-client-ui-primitives': UiPrimitives,
  } });
  const ctx = context = new Cordis.Context();
  await ctx.plugin(Loader);
  ctx.loader.internal = modules;
  await Promise.all(modules.manifest.plugins.filter((row: { immediately?: boolean }) => row.immediately).map((row: { id: string }) => modules.prefetch(row.id)));
  await Promise.all(modules.manifest.plugins.map((row: { id: string }) => ctx.loader.create({ name: row.id })));
  await ctx.loader.await();
  const failed = Array.from(ctx.loader.entries()).filter(entry => entry.fiber?.state !== 2);
  if (failed.length) throw new Error(`DSH 模块未激活：${failed.map(entry => entry.options.name).join(', ')}`);
  status.unmount();
  await ctx.inject(['uiRenderer'], scope => {
    scope.effect(() => (scope.get('uiRenderer') as { mount(root: HTMLElement): () => void }).mount(root));
  });
  await window.dshDesktop!.ready();
}
void bootDesktop().catch(error => { console.error(error); status.render(<Startup error={error instanceof Error ? error.message : '启动失败'} />); });
addEventListener('beforeunload', () => { void context?.fiber.dispose(); });
