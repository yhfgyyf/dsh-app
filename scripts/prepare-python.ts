import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { applyWorkspaceDependencies } = await import(new URL('install-workspace-dependencies.mjs', import.meta.url).href);
const run = promisify(execFile);
type Download = { filename: string; url: string; sha256: string; bytes: number };
type Lock = { python: string; release: string; packages: Record<string, string>; targets: Record<string, { archive: Download; wheels: Download[] }> };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function download(asset: Download, directory: string) {
  await mkdir(directory, { recursive: true });
  assert.equal(asset.filename, asset.filename.split(/[\\/]/).at(-1), 'Invalid download filename');
  const path = join(directory, asset.filename);
  const valid = (bytes: Buffer) => bytes.length === asset.bytes && sha(bytes) === asset.sha256;
  try { if (valid(await readFile(path))) return path; } catch { /* First preparation downloads pinned assets. */ }
  const url = new URL(asset.url);
  assert.ok(url.protocol === 'https:' && ['github.com', 'files.pythonhosted.org'].includes(url.hostname), 'Unexpected runtime source');
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Python payload download failed (${response.status}): ${asset.filename}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(valid(bytes), `Python payload checksum/size mismatch: ${asset.filename}`);
  await writeFile(path, bytes);
  return path;
}

/** Build a private, relocatable payload without using the host Python or pip. */
export async function preparePython() {
  const lock = JSON.parse(await readFile(join(root, 'runtime/python-lock.json'), 'utf8')) as Lock;
  const target = `${process.platform}-${process.arch}`;
  const pin = lock.targets[target];
  if (!pin) throw new Error(`No verified Python binary for ${target}; Kylin uses its separately audited old-world build.`);
  const cache = join(root, '.build-runtime/python');
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, 'staging-'));
  const archive = await download(pin.archive, join(cache, 'archives'));
  await run('tar', ['-xzf', archive, '-C', staging], { windowsHide: true });
  const payload = join(staging, 'python');
  const executable = (base: string) => join(base, ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
  const python = executable(payload);
  const cleanEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };
  for (const name of ['PYTHONHOME', 'PYTHONPATH']) delete cleanEnv[name as keyof typeof cleanEnv];
  assert.equal((await run(python, ['-I', '-B', '--version'], { env: cleanEnv })).stdout.trim(), `Python ${lock.python}`);
  const wheels = await Promise.all(pin.wheels.map(asset => download(asset, join(cache, 'wheels', target))));
  await run(python, ['-I', '-B', '-m', 'pip', 'install', '--isolated', '--disable-pip-version-check', '--no-index', '--no-deps', '--no-compile', '--no-cache-dir', '--no-warn-script-location', ...wheels], { env: cleanEnv, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  await run(python, ['-I', '-B', '-m', 'pip', 'check'], { env: cleanEnv, windowsHide: true });
  const inventoryScript = 'import importlib.metadata as m,json; print(json.dumps({d.metadata["Name"]:d.version for d in m.distributions()}))';
  const inventory = JSON.parse((await run(python, ['-I', '-B', '-c', inventoryScript], { env: cleanEnv })).stdout) as Record<string, string>;
  const normalized = Object.fromEntries(Object.entries(inventory).map(([name, value]) => [name.toLowerCase().replaceAll(/[-_.]+/g, '-'), value]));
  for (const [name, version] of Object.entries(lock.packages)) assert.equal(normalized[name.toLowerCase().replaceAll(/[-_.]+/g, '-')], version, name);
  const node = join(root, '.runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  await run(python, ['-I', '-B', join(root, 'examples/office-smoke.py'), '--output', join(staging, 'office-test'), '--node', node], { env: cleanEnv, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const destination = join(root, '.runtime/dependencies/python');
  await mkdir(join(root, '.runtime/dependencies'), { recursive: true });
  try { await rename(destination, join(staging, 'python-before')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await rename(payload, destination);
  // Exercise the relocated interpreter too; installed wheel entry-point shebangs
  // are not used. Call pip and libraries with this absolute Python and -m.
  await run(executable(destination), ['-I', '-B', join(root, 'examples/office-smoke.py'), '--output', join(staging, 'relocated-test'), '--node', node], { env: cleanEnv, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  await cp(join(root, 'examples'), join(root, '.runtime/examples'), { recursive: true });
  await cp(join(root, 'runtime/python-licenses'), join(root, '.runtime/licenses/python-build-standalone'), { recursive: true });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const pnpm = JSON.parse(await readFile(join(root, '.runtime/package-manager/node_modules/pnpm/package.json'), 'utf8'));
  const nodeVersion = (await run(node, ['--version'])).stdout.trim().replace(/^v/, '');
  await writeFile(join(root, '.runtime/runtime.json'), JSON.stringify({ desktopVersion: pkg.version, platform: process.platform, arch: process.arch, python: lock.python, node: nodeVersion, pnpm: pnpm.version, pythonPackages: inventory }, null, 2) + '\n');
  await cp(join(root, 'runtime/python-lock.json'), join(root, '.runtime/python-provenance.json'));
  await applyWorkspaceDependencies();
  console.log(`Prepared Python ${lock.python} with ${Object.keys(lock.packages).length} pinned Office/PDF libraries for ${target}; original and relocated round trips passed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await preparePython();
