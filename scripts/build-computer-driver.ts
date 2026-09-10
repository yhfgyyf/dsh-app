import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const exists = (path: string) => access(path).then(() => true, () => false);
const run = (command: string, args: string[], cwd: string, env = process.env) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});
type PatchPin = {
  patchId: string; sourceRepository: string; sourceCommit: string; sourceTree: string;
  toolchain: string; patchFile: string; patchSha256: string; cargoLockSha256: string;
};
const buildIdentity = (pin: PatchPin, target: string) => ({ patchId: pin.patchId, sourceCommit: pin.sourceCommit, sourceTree: pin.sourceTree, cargoLockSha256: pin.cargoLockSha256, patchSha256: pin.patchSha256, toolchain: pin.toolchain, target });

/** Check the unsigned runtime before bundling; macOS signing changes its binary hash. */
export async function verifyComputerDriverBuild(runtimeRoot: string) {
  if (process.platform !== 'darwin') return;
  try {
    if (!['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported macOS architecture.');
    const pinRoot = join(root, 'runtime/computer-use');
    const pin = JSON.parse(await readFile(join(pinRoot, 'native-patch.json'), 'utf8')) as PatchPin;
    if (sha256(await readFile(join(pinRoot, pin.patchFile))) !== pin.patchSha256) throw new Error('Source patch SHA-256 mismatch.');
    const runtimePin = JSON.parse(await readFile(join(runtimeRoot, 'native-patch.json'), 'utf8'));
    if (!Object.entries(pin).every(([key, value]) => runtimePin[key] === value)) throw new Error('Runtime patch pin differs from the source pin.');
    const metadata = JSON.parse(await readFile(join(runtimeRoot, 'driver-build.json'), 'utf8'));
    const identity = buildIdentity(pin, process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
    if (!Object.entries(identity).every(([key, value]) => metadata[key] === value)) throw new Error('Runtime build identity differs from the source pin.');
    if (metadata.binarySha256 !== sha256(await readFile(join(runtimeRoot, 'bin/cua-driver')))) throw new Error('Runtime worker SHA-256 mismatch.');
  } catch (error) {
    throw new Error(`Computer driver runtime is not the pinned macOS build; run npm run setup:computer-use. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Build the pinned macOS worker; the released SDK and other platforms stay intact. */
export async function buildComputerDriver() {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('The patched computer driver requires macOS arm64 or x64.');
  const pinRoot = join(root, 'runtime/computer-use');
  const pin = JSON.parse(await readFile(join(pinRoot, 'native-patch.json'), 'utf8')) as PatchPin;
  const patchPath = join(pinRoot, pin.patchFile);
  const patch = await readFile(patchPath);
  if (sha256(patch) !== pin.patchSha256) throw new Error('Computer driver patch SHA-256 does not match its pin.');
  const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const cache = join(root, '.build-runtime/computer-use');
  const source = join(cache, 'native-source');
  await mkdir(cache, { recursive: true });
  if (!await exists(join(source, '.git'))) {
    await run('git', ['clone', '--filter=blob:none', '--no-checkout', pin.sourceRepository, source], root);
    await run('git', ['sparse-checkout', 'set', 'libs/cua-driver/rust'], source);
    await run('git', ['checkout', '--detach', pin.sourceCommit], source);
  }
  const git = async (...args: string[]) => (await exec('git', args, { cwd: source, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  if (await git('rev-parse', 'HEAD') !== pin.sourceCommit || await git('rev-parse', 'HEAD:libs/cua-driver/rust') !== pin.sourceTree) throw new Error('Computer driver source commit/tree does not match its pin.');
  const rustRoot = join(source, 'libs/cua-driver/rust');
  if (sha256(await readFile(join(rustRoot, 'Cargo.lock'))) !== pin.cargoLockSha256) throw new Error('Computer driver Cargo.lock does not match its pin.');
  if (await git('ls-files', '--others', '--exclude-standard', '--', 'libs/cua-driver/rust')) throw new Error('Computer driver source has untracked files; preserve and inspect that checkout before building.');
  // Keep patch serialization independent of local diff settings and hash abbreviation.
  const diff = async () => (await exec('git', ['-c', 'core.quotePath=true', 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--diff-algorithm=myers', '--indent-heuristic', '--unified=3', '--inter-hunk-context=0', '--no-renames', 'HEAD', '--', 'libs/cua-driver/rust'], { cwd: source, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout;
  if (!(await diff()).length) {
    await run('git', ['apply', '--check', patchPath], source);
    await run('git', ['apply', patchPath], source);
  }
  if (!(await diff()).equals(patch)) throw new Error('Computer driver source has changes beyond the pinned patch; preserve and inspect that checkout before building.');

  const output = join(cache, 'patched', target);
  const binaryPath = join(output, 'cua-driver');
  const metadataPath = join(output, 'driver-build.json');
  const identity = buildIdentity(pin, target);
  try {
    const previous = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (Object.entries(identity).every(([key, value]) => previous[key] === value) && previous.binarySha256 === sha256(await readFile(binaryPath))) return { binaryPath, metadataPath };
  } catch { /* First build or an incomplete cache. */ }

  const bundledCargoHome = join(root, '.build-runtime/rust/cargo');
  const bundledRustupHome = join(root, '.build-runtime/rust/rustup');
  const useBundledRust = !process.env.CARGO_HOME && !process.env.RUSTUP_HOME && await exists(join(bundledCargoHome, 'bin/cargo')) && await exists(bundledRustupHome);
  const cargoHome = process.env.CARGO_HOME ?? (useBundledRust ? bundledCargoHome : undefined);
  const rustupHome = process.env.RUSTUP_HOME ?? (useBundledRust ? bundledRustupHome : undefined);
  const cargo = cargoHome && await exists(join(cargoHome, 'bin/cargo')) ? join(cargoHome, 'bin/cargo') : 'cargo';
  const targetDirectory = join(rustRoot, 'target');
  const env = { ...process.env, ...(cargoHome ? { CARGO_HOME: cargoHome, PATH: `${join(cargoHome, 'bin')}:${process.env.PATH ?? ''}` } : {}), ...(rustupHome ? { RUSTUP_HOME: rustupHome } : {}), CARGO_TARGET_DIR: targetDirectory };
  const version = (await exec(cargo, [`+${pin.toolchain}`, '--version'], { cwd: rustRoot, env })).stdout.trim();
  if (!version.startsWith(`cargo ${pin.toolchain} `)) throw new Error(`Computer driver needs Rust ${pin.toolchain}; got ${version}.`);
  const builtBinary = await new Promise<string>((resolve, reject) => {
    const child = spawn(cargo, [`+${pin.toolchain}`, 'build', '--locked', '--release', '--message-format=json-render-diagnostics', '-p', 'cua-driver', '--bin', 'cua-driver'], { cwd: rustRoot, env, stdio: ['inherit', 'pipe', 'inherit'] });
    let pending = '';
    let executable: string | undefined;
    const inspect = (line: string) => {
      try {
        const message = JSON.parse(line);
        if (message.reason === 'compiler-artifact' && message.target?.name === 'cua-driver' && message.target.kind?.includes('bin') && typeof message.executable === 'string') executable = message.executable;
      } catch { /* Cargo may emit informational lines alongside its JSON events. */ }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) inspect(line);
    });
    child.once('error', reject);
    child.once('close', code => {
      inspect(pending);
      if (code !== 0) reject(new Error(`${cargo} exited with ${code}`));
      else if (!executable) reject(new Error('Cargo did not report the computer driver executable.'));
      else resolve(executable);
    });
  });
  const architecture = (await exec('lipo', ['-archs', builtBinary])).stdout.trim();
  if (architecture !== (process.arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error(`Computer driver build architecture mismatch: expected ${target}, got ${architecture}. Check local Cargo cross-compilation settings.`);
  await mkdir(output, { recursive: true });
  await copyFile(builtBinary, binaryPath);
  await writeFile(metadataPath, JSON.stringify({ ...identity, binarySha256: sha256(await readFile(binaryPath)) }, null, 2) + '\n');
  console.log(`Built ${pin.patchId} (${target}); metadata ${metadataPath}`);
  return { binaryPath, metadataPath };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildComputerDriver();
