import assert from 'node:assert/strict';
import { readFile, writeFile, rename, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [providerArg, output] = process.argv.slice(2);
assert(providerArg && output, 'Usage: node test-offline-failures.mjs DISPOSABLE_PROVIDER RESULT.json');
const provider = resolve(providerArg);
assert.equal(await readFile(join(provider, '.dsh-speech-disposable-test-stage'), 'utf8'), 'Disposable speech fixture\n');
const { Config, apply } = await import(pathToFileURL(join(provider, 'lib/index.js')).href);
const models = join(provider, 'runtime/models');
const dataRoot = join(provider, 'test-data');
await mkdir(dataRoot, { recursive: true });
const checks = [];
let fetches = 0, spawns = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { fetches++; throw new Error('No network allowed'); };

async function activate(options = {}, expectedFailure = false) {
  let registration, cleanup;
  try {
    apply({
      effect(fn) { cleanup = fn(); }, logger: { warn() {} },
      speechToText: { register(value) { registration = value; return async () => {}; } },
      subprocess: { spawn() { spawns++; throw new Error('No worker should start in preparation failure tests'); } },
    }, Config({ dataRoot, idleTimeoutMs: 0, ...options }));
    await registration.preparation.preparing.settled;
    assert.deepEqual(registration.info.downloadSources, []);
    if (expectedFailure) {
      assert.equal(registration.preparation.snapshot().phase, 'unprepared');
      registration.preparation.prepare();
      await registration.preparation.preparing.settled;
      const state = registration.preparation.snapshot();
      assert.equal(state.phase, 'failed');
      assert.match(state.message, /Offline speech model verification failed/);
      return { phase: state.phase, message: state.message };
    }
    assert.equal(registration.preparation.snapshot().phase, 'standby');
    return { phase: 'standby', runtime: registration.preparation.runtime };
  } finally { await cleanup?.(); }
}

try {
  const vad = join(models, 'silero/silero_vad.onnx');
  await rename(vad, vad + '.test-saved');
  try { checks.push({ name: 'missing bundled VAD fails offline', ...await activate({}, true) }); }
  finally { await rename(vad + '.test-saved', vad); }

  const tokens = join(models, 'sensevoice-onnx/tokens.txt');
  const original = await readFile(tokens);
  const corrupt = Buffer.from(original);
  corrupt[0] ^= 1;
  await writeFile(tokens, corrupt);
  try { checks.push({ name: 'same-size bad SHA256 fails offline', ...await activate({}, true) }); }
  finally { await writeFile(tokens, original); }

  checks.push({ name: 'unbundled fp32 fails offline', ...await activate({ precision: 'fp32' }, true) });

  const custom = join(dataRoot, 'explicit-models');
  await mkdir(custom, { recursive: true });
  for (const file of ['model.int8.onnx', 'tokens.txt']) {
    try { await symlink(join(models, 'sensevoice-onnx', file), join(custom, file)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const explicit = await activate({ modelDirectory: custom, vadModelPath: vad });
  assert.equal(explicit.runtime.model, join(custom, 'model.int8.onnx'));
  assert.equal(explicit.runtime.vad, vad);
  checks.push({ name: 'explicit local model paths respected', ...explicit });
  assert.equal(fetches, 0);
  assert.equal(spawns, 0);
} finally { globalThis.fetch = originalFetch; }

const result = { at: new Date().toISOString(), node: process.version, provider, checks, fetches, spawns, success: true };
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
