import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'dsh-desktop-plugin-bundle-metadata';
export const inject = ['pluginManager', 'pluginPackages', 'profileContext'];

interface Bundle {
  name: string;
  installed: boolean;
  version?: string;
  description?: string;
  meta?: unknown;
  error?: unknown;
}
interface RuntimeContext {
  pluginManager: { listBundles(): Promise<Bundle[]> };
  pluginPackages: {
    packageOf(name: string, parentURL: string): { manifestPath: string } | undefined;
    metaOf(name: string, parentURL: string): unknown;
  };
  profileContext: { dir: string };
  effect(factory: () => () => void, label: string): unknown;
}

/** Keep bundle composition with the host, but display the package the profile resolves. */
export function apply(ctx: RuntimeContext) {
  const manager = ctx.pluginManager;
  const parentURL = pathToFileURL(join(ctx.profileContext.dir, 'package.json')).href;
  ctx.effect(() => {
    const descriptor = Object.getOwnPropertyDescriptor(manager, 'listBundles');
    const original = manager.listBundles;
    async function listBundles(this: RuntimeContext['pluginManager']) {
      const bundles = await original.call(this);
      return bundles.map(bundle => {
        if (!bundle.installed || bundle.error) return bundle;
        try {
          const resolved = ctx.pluginPackages.packageOf(bundle.name, parentURL);
          if (!resolved) return bundle;
          // Read again after upgrades; PluginPackages caches parsed manifests within a generation.
          const manifest = JSON.parse(readFileSync(resolved.manifestPath, 'utf8'));
          if (manifest.name !== bundle.name) return bundle;
          const result = { ...bundle };
          delete result.version;
          delete result.description;
          delete result.meta;
          if (typeof manifest.version === 'string') result.version = manifest.version;
          if (typeof manifest.description === 'string' && manifest.description) result.description = manifest.description;
          const meta = ctx.pluginPackages.metaOf(bundle.name, parentURL);
          if (meta !== undefined) result.meta = meta;
          return result;
        } catch {
          // Keep the manager's existing diagnostics when an installation is temporarily unreadable.
          return bundle;
        }
      });
    }
    Object.defineProperty(manager, 'listBundles', { configurable: true, writable: true, value: listBundles });
    return () => {
      if (Object.getOwnPropertyDescriptor(manager, 'listBundles')?.value !== listBundles) return;
      if (descriptor) Object.defineProperty(manager, 'listBundles', descriptor);
      else Reflect.deleteProperty(manager, 'listBundles');
    };
  }, name);
}
