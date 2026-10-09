import assert from 'node:assert/strict';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const excluded = ['plugins/dsh-p2p-collab', 'node_modules/dsh-p2p-collab', 'local-plugins'];
const anonymousManifest = '{\n  "private": true\n}\n';

export async function copyPackagedRuntime(source: string, destination: string) {
  await cp(source, destination, { recursive: true, dereference: true, filter: path => {
    const name = relative(source, path).split(sep).join('/');
    return !excluded.some(entry => name === entry || name.startsWith(entry + '/'));
  } });
  const manifestPath = join(destination, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.dependencies?.['dsh-p2p-collab'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await mkdir(join(destination, 'local-plugins'), { recursive: true });
  await writeFile(join(destination, 'local-plugins/package.json'), anonymousManifest, { flag: 'wx' });
  await verifyPackagedRuntime(destination);
}

export async function verifyPackagedRuntime(runtime: string) {
  for (const path of excluded.slice(0, 2)) {
    await assert.rejects(stat(join(runtime, path)), { code: 'ENOENT' }, 'The package must not preinstall dsh-p2p-collab');
  }
  const manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['dsh-p2p-collab'], undefined);
  assert.equal(await readFile(join(runtime, 'local-plugins/package.json'), 'utf8'), anonymousManifest);
}
