import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const patchDirectory = fileURLToPath(new URL('../patches/loongarch-speech/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function matches(path, asset) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== asset.bytes) return false;
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    return hash.digest('hex') === asset.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Install only into an explicitly identified, staged Kylin runtime. No downloads or install hooks. */
export async function installLoongarchSpeech({ target, runtimeNodeModules, artifactDirectory, modelsDirectory, mode = 'apply' }) {
  if (target !== 'linux-loong64' || !isAbsolute(runtimeNodeModules ?? '')) throw new Error('An explicit linux-loong64 staging node_modules path is required');
  if (!['apply', 'verify'].includes(mode)) throw new Error('Unsupported speech installation mode');
  const runtime = await json(join(runtimeNodeModules, '..', 'runtime.json'));
  if (runtime.platform !== 'linux' || runtime.arch !== 'loong64' || runtime.dsh !== '0.2.0-rc.1') throw new Error('Speech installer requires a DSH 0.2.0-rc.1 Linux LoongArch staging runtime');
  const manifest = await json(join(patchDirectory, 'manifest.json'));
  const payload = await json(join(patchDirectory, 'payload-manifest.json'));
  const provider = join(runtimeNodeModules, manifest.package);
  const pkg = await json(join(provider, 'package.json'));
  if (pkg.name !== manifest.package || pkg.version !== manifest.version) throw new Error('Unrecognized SenseVoice provider version; files preserved');
  const patch = join(patchDirectory, 'runtime.patch');
  if (sha(await readFile(patch)) !== manifest.patchSha256) throw new Error('Speech patch checksum differs');
  const originals = [];
  for (const [file, hashes] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(provider, file));
    const digest = sha(bytes);
    if (![hashes.before, hashes.after].includes(digest)) throw new Error('Unrecognized provider changes preserved: ' + file);
    originals.push({ file, bytes, patched: digest === hashes.after });
  }
  if (originals.some(item => item.patched) && originals.some(item => !item.patched)) throw new Error('Partially patched provider; restore the backup before retrying');
  const files = [
    ...payload.files.map(asset => ({ ...asset, source: artifactDirectory && join(artifactDirectory, asset.path) })),
    ...payload.models.map(asset => ({ ...asset, source: modelsDirectory && join(modelsDirectory, asset.source) })),
  ];
  const pending = [];
  for (const asset of files) {
    const destination = join(provider, 'runtime', asset.path);
    if (await matches(destination, asset)) continue;
    if (mode === 'verify') throw new Error('Missing or corrupted offline speech asset: ' + asset.path);
    if (!asset.source || !await matches(asset.source, asset)) throw new Error('Missing or corrupted source speech asset: ' + asset.path);
    pending.push({ ...asset, destination });
  }
  if (mode === 'verify' && !originals[0].patched) throw new Error('Kylin speech provider patch is missing');
  let backup;
  if (mode === 'apply') {
    // Verify all inputs before copying anything. Publish each complete file atomically.
    for (const asset of pending) {
      await mkdir(dirname(asset.destination), { recursive: true });
      const partial = asset.destination + '.dsh-speech-part';
      try {
        await copyFile(asset.source, partial);
        if (!await matches(partial, asset)) throw new Error('Copied speech asset checksum differs: ' + asset.path);
        await rename(partial, asset.destination);
      } finally { await rm(partial, { force: true }); }
    }
    if (!originals[0].patched) {
      backup = join(runtimeNodeModules, '..', 'speech-provider-backup-' + manifest.version);
      await mkdir(backup, { recursive: true });
      for (const { file, bytes } of originals) {
        const saved = join(backup, file);
        await mkdir(dirname(saved), { recursive: true });
        await writeFile(saved, bytes);
        if (sha(await readFile(saved)) !== sha(bytes)) throw new Error('Speech provider backup checksum differs');
      }
      const scratch = await mkdtemp(join(tmpdir(), 'dsh-loongarch-speech-'));
      try {
        for (const check of [true, false]) {
          const result = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--unsafe-paths', '--directory=' + runtimeNodeModules.replaceAll('\\', '/'), ...(check ? ['--check'] : []), patch], { cwd: scratch, encoding: 'utf8' });
          if (result.status !== 0) throw new Error(result.stderr || 'Speech provider patch failed');
        }
      } finally { await rm(scratch, { recursive: true, force: true }); }
    }
  }
  for (const [file, hashes] of Object.entries(manifest.files)) {
    if (sha(await readFile(join(provider, file))) !== hashes.after) throw new Error('Speech provider result checksum differs: ' + file);
  }
  return {
    target, verified: true, changedFiles: pending.length + (originals[0].patched ? 0 : originals.length), backup,
    provider, manifest: join(patchDirectory, 'payload-manifest.json'),
    provenance: join(provider, 'runtime', 'speech-provenance.json'),
    addedBytes: files.reduce((total, file) => total + file.bytes, 0),
    wasm: payload.files.find(file => file.path.endsWith('.wasm')),
    models: payload.models,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    target: { type: 'string' }, 'runtime-node-modules': { type: 'string' },
    'artifact-directory': { type: 'string' }, 'models-directory': { type: 'string' }, mode: { type: 'string', default: 'apply' },
  } });
  console.log(JSON.stringify(await installLoongarchSpeech({
    target: values.target, runtimeNodeModules: values['runtime-node-modules'],
    artifactDirectory: values['artifact-directory'], modelsDirectory: values['models-directory'], mode: values.mode,
  }), null, 2));
}
