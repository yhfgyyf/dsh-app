import type { IndexInjection } from '../shared/dsh-boot.ts';

// Same ordered interpretation as dsh-client-web/src/apply-injections.ts.
export async function applyIndexInjections(rows: readonly IndexInjection[], loadScript: (src: string) => Promise<void>): Promise<void> {
  for (const row of rows) {
    switch (row.kind) {
      case 'global':
        (globalThis as Record<string, unknown>)[row.name] = row.value;
        break;
      case 'script': {
        const script = document.createElement('script');
        script.textContent = row.text;
        (row.placement === 'head' ? document.head : document.body).append(script);
        break;
      }
      case 'script-src':
        await loadScript(row.src);
        break;
      case 'script-preload':
        // Advisory only; the owning loader controls the actual request.
        break;
      case 'style': {
        const style = document.createElement('style');
        style.textContent = row.text;
        document.head.append(style);
        break;
      }
      case 'html':
        (row.placement === 'head' ? document.head : document.body).insertAdjacentHTML('beforeend', row.html);
        break;
      default:
        throw new Error('DSH 页面注入类型不兼容。');
    }
  }
}
