import { mkdir, readFile, writeFile, cp, rename, access, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (command: string, args: string[], cwd: string) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});

export async function prepareComputerUse() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('Computer use requires macOS or Windows.');
  if (process.platform === 'win32' && process.arch !== 'x64') throw new Error('The pinned Windows driver requires x64.');
  const pin = JSON.parse(await readFile(join(root, 'runtime/computer-use/driver.json'), 'utf8'));
  const asset = pin.assets[process.platform] as { name: string; directory: string; sha256: string; bytes: number; files: string[] };
  const cache = join(root, '.build-runtime/computer-use');
  await mkdir(cache, { recursive: true });
  const archive = join(cache, asset.name);
  const valid = (data: Buffer) => data.length === asset.bytes && createHash('sha256').update(data).digest('hex') === asset.sha256;
  let cached = false;
  try { cached = valid(await readFile(archive)); } catch { /* First build downloads the immutable release asset. */ }
  if (!cached) {
    const response = await fetch(`https://github.com/${pin.repository}/releases/download/${pin.tag}/${asset.name}`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Driver download failed (${response.status}).`);
    const data = Buffer.from(await response.arrayBuffer());
    if (!valid(data)) throw new Error('Driver archive SHA-256 does not match the pin.');
    await writeFile(archive, data);
  }
  const staging = join(cache, `staging-${Date.now()}`);
  const extracted = join(staging, 'extracted');
  const runtime = join(staging, 'runtime');
  await mkdir(extracted, { recursive: true });
  await mkdir(join(runtime, 'bin'), { recursive: true });
  await run('tar', ['-xf', archive, '-C', extracted], root);
  const assetRoot = join(extracted, asset.directory);
  for (const name of asset.files) {
    await cp(join(assetRoot, name), join(runtime, 'bin', name));
    if (process.platform !== 'win32') await chmod(join(runtime, 'bin', name), 0o755);
  }
  for (const name of ['package.json', 'package-lock.json', 'driver.json']) await cp(join(root, 'runtime/computer-use', name), join(runtime, name));
  await cp(join(root, 'runtime/computer-use/licenses'), join(runtime, 'licenses'), { recursive: true });
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run through npm: npm run setup:computer-use');
  await run(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund', '--ignore-scripts'], runtime);
  // Preserve the previous generated runtime until the replacement is complete.
  const destination = join(root, '.runtime/computer-use');
  await mkdir(join(root, '.runtime'), { recursive: true });
  try { await access(destination); await rename(destination, join(cache, `runtime-before-${Date.now()}`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await rename(runtime, destination);
  console.log(`Prepared Cua ${pin.version} (${process.platform}/${process.arch}); archive SHA-256 ${asset.sha256}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await prepareComputerUse();
