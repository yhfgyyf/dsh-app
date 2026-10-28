import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Verify image preservation integrated in the pinned plugin; never inject a duplicate image. */
export async function applyProgressiveImages({ runtimeNodeModules = join(root, '.runtime/node_modules'), mode = 'apply' } = {}) {
  if (!['apply', 'check', 'verify'].includes(mode)) throw new Error('Unknown progressive image verification mode');
  const pin = JSON.parse(await readFile(join(root, 'patches/progressive-images/manifest.json'), 'utf8'));
  const base = join(runtimeNodeModules, pin.package);
  const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
  if (pkg.name !== pin.package || pkg.version !== pin.version) throw new Error('Unexpected progressive-tools image contract.');
  const path = join(base, pin.path);
  if (sha(await readFile(path)) !== pin.sha256) throw new Error('Unrecognized progressive-tools changes preserved: ' + path);
  return mode === 'check' ? { pending: 0 } : { changed: false };
}
