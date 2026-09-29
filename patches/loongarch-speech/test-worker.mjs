// Run with Node 22 against an isolated patched provider, or read-only against a packaged provider.
// Inputs are a synthetic fixture and local assets; this never opens a microphone.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const [providerArg, fixture, output] = process.argv.slice(2);
assert(providerArg && fixture && output, 'Usage: node test-worker.mjs PROVIDER_DIRECTORY SYNTHETIC.wav RESULT.json');
const provider = resolve(providerArg);
const wav = await readFile(fixture);
const runtime = join(provider, 'runtime');
const workerPath = join(provider, 'lib/worker.js');
const config = {
  dataRoot: process.cwd(),
  model: join(runtime, 'models/sensevoice-onnx/model.int8.onnx'),
  tokens: join(runtime, 'models/sensevoice-onnx/tokens.txt'),
  vad: join(runtime, 'models/silero/silero_vad.onnx'),
};
const token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [workerPath, JSON.stringify(config)], {
  env: { ...process.env, DSH_SPEECH_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
});
const exit = once(child, 'exit');
let stdout = '', stderr = '';
child.stderr.on('data', bytes => { stderr += bytes; });
const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
const checks = [];
try {
  const port = await new Promise((resolvePort, reject) => {
    child.stdout.on('data', bytes => {
      stdout += bytes;
      if (stdout.includes('\n')) {
        try { resolvePort(JSON.parse(stdout.trim()).port); } catch (error) { reject(error); }
      }
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Worker exited: ' + code + '\n' + stderr)));
  });
  const send = async (bytes, { language = 'en', authorized = true } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/transcribe?language=${language}`, {
      method: 'POST', body: bytes, headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length), ...(authorized ? { authorization: 'Bearer ' + token } : {}) },
    });
    return { status: response.status, result: await response.json() };
  };
  const unauthorized = await send(wav, { authorized: false });
  assert.equal(unauthorized.status, 401);
  checks.push({ name: 'authentication preserved', ...unauthorized });
  const empty = await send(Buffer.alloc(0));
  assert.equal(empty.status, 413);
  checks.push({ name: 'empty audio rejected', ...empty });
  const language = await send(wav, { language: 'unsupported' });
  assert.equal(language.status, 400);
  checks.push({ name: 'invalid language rejected before inference', ...language });
  const malformed = await send(Buffer.alloc(46));
  assert.equal(malformed.status, 400);
  checks.push({ name: 'invalid WAV rejected', ...malformed });
  const silence = Buffer.from(wav);
  silence.fill(0, 44);
  const silent = await send(silence);
  assert.equal(silent.status, 200);
  assert.equal(silent.result.text, '');
  checks.push({ name: 'silence produces empty text', ...silent });
  for (let i = 0; i < 2; i++) {
    const speech = await send(wav);
    assert.equal(speech.status, 200);
    assert.equal(speech.result.text.toLowerCase().replace(/[^a-z]+/g, ' ').trim(), 'hello world this is a local speech recognition test');
    checks.push({ name: 'synthetic speech round ' + (i + 1), ...speech });
  }
} finally {
  clearTimeout(timeout);
  child.kill('SIGTERM');
  await exit;
}

// Exercise the patched stream lifetime on both success and decoder failure.
const workerSource = await readFile(workerPath, 'utf8');
const inferenceSource = workerSource.slice(workerSource.indexOf('function createTranscriber(config) {'), workerSource.indexOf('\n//#endregion', workerSource.indexOf('function createTranscriber(config) {'))).replace('import.meta.url', '"isolated-test"');
for (const fail of [false, true]) {
  let frees = 0, pending = true;
  const sherpa = {
    createOfflineRecognizer: () => ({
      setConfig() {}, createStream: () => ({ acceptWaveform() {}, free() { frees++; } }),
      decode() { if (fail) throw new Error('decoder fixture failure'); }, getResult: () => ({ text: 'test' }),
    }),
    createVad: () => ({ reset() {}, isEmpty: () => !pending, front: () => ({ samples: new Float32Array(1) }), pop() { pending = false; }, acceptWaveform() {}, flush() {} }),
  };
  const createTranscriber = runInNewContext('(' + inferenceSource + ')', {
    createRequire: () => () => sherpa, validateInput: () => 1, performance, Float32Array, DataView,
  });
  const transcribe = createTranscriber(config);
  if (fail) assert.throws(() => transcribe(wav, 'en'), /decoder fixture failure/);
  else transcribe(wav, 'en');
  assert.equal(frees, 1);
  checks.push({ name: 'stream freed on ' + (fail ? 'decoder failure' : 'success'), frees });
}

// Public provider activation must inspect packaged default assets without starting a worker or fetching.
const providerModule = await import(pathToFileURL(join(provider, 'lib/index.js')).href);
let registered, cleanup, fetches = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { fetches++; throw new Error('Network is forbidden in offline preparation'); };
try {
  providerModule.apply({
    effect(fn) { cleanup = fn(); }, logger: { warn() {} },
    speechToText: { register(value) { registered = value; return async () => {}; } },
    subprocess: { spawn() { throw new Error('Activation must not spawn'); } },
  }, providerModule.Config({ dataRoot: process.cwd(), idleTimeoutMs: 0 }));
  await registered.preparation.preparing.settled;
  assert.equal(registered.preparation.snapshot().phase, 'standby');
  assert.deepEqual(registered.info.downloadSources, []);
  assert.equal(fetches, 0);
  checks.push({ name: 'offline defaults verified on activation', phase: registered.preparation.snapshot().phase, fetches });
} finally { await cleanup?.(); globalThis.fetch = originalFetch; }

const result = {
  at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  provider, fixture, fixtureSha256: createHash('sha256').update(wav).digest('hex'),
  backend: 'sherpa-onnx 1.13.8 / ONNX Runtime 1.28.2 scalar WebAssembly, one CPU thread',
  scope: 'Synthetic audio through patched official authenticated worker plus provider offline inspection; no microphone, no cloud service, no simulated host platform.',
  checks, stderrBytes: stderr.length, success: true,
};
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
