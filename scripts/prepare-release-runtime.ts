import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Remove the build-only collaboration fixture from the private runtime. */
export async function prepareReleaseRuntime(runtime: string) {
  const manifestPath = join(runtime, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.name, 'dsh-desktop-runtime');
  for (const directory of ['plugins/dsh-p2p-collab', 'node_modules/dsh-p2p-collab']) {
    await rm(join(runtime, directory), { recursive: true, force: true });
  }
  if (manifest.dependencies?.['dsh-p2p-collab']) {
    delete manifest.dependencies['dsh-p2p-collab'];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  const pluginRoot = join(runtime, 'local-plugins');
  await mkdir(pluginRoot, { recursive: true });
  const anonymousManifest = join(pluginRoot, 'package.json');
  try {
    await writeFile(anonymousManifest, '{\n  "private": true\n}\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assert.deepEqual(JSON.parse(await readFile(anonymousManifest, 'utf8')), { private: true });
}
