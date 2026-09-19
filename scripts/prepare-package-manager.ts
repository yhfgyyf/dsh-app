import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

/** Install the pinned package manager separately from the core dependency graph. */
export async function preparePackageManager() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run through npm: npm run setup:package-manager');
  const pins = JSON.parse(await readFile(join(root, 'runtime/dependencies.json'), 'utf8'));
  const node = join(root, '.runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  assert.equal((await run(node, ['--version'])).stdout.trim(), `v${pins.node}`, 'Package manager requires the pinned bundled Node');
  const manifest = JSON.parse(await readFile(join(root, 'runtime/pnpm/package.json'), 'utf8'));
  const cache = join(root, '.build-runtime/package-manager');
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, 'staging-'));
  const install = join(staging, 'install');
  const runtime = join(staging, 'runtime');
  await mkdir(install);
  for (const name of ['package.json', 'package-lock.json']) await cp(join(root, 'runtime/pnpm', name), join(install, name));
  await run(node, [npmCli, 'ci', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund'], { cwd: install, windowsHide: true });
  // No executable links enter the packaged runtime; the host calls pnpm's JS entry.
  await cp(install, runtime, { recursive: true, dereference: true });
  const entry = join(runtime, 'node_modules/pnpm/bin/pnpm.mjs');
  const version = (await run(node, ['--expose-internals', entry, '--version'], { cwd: staging })).stdout.trim();
  assert.equal(version, manifest.dependencies.pnpm, 'Installed pnpm differs from its exact pin');
  const destination = join(root, '.runtime/package-manager');
  try { await rename(destination, join(staging, 'runtime-before')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await rename(runtime, destination);
  console.log(`Prepared independent pnpm ${version} with bundled Node ${pins.node}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await preparePackageManager();
