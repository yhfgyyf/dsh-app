import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [wasm, wasmOpt, output] = process.argv.slice(2);
assert(wasm && wasmOpt && output, 'Usage: node validate-scalar-wasm.mjs RUNTIME.wasm WASM_OPT RESULT.json');
const bytes = await readFile(wasm);
const scratch = await mkdtemp(join(tmpdir(), 'dsh-scalar-validation-'));
try {
  // Enable only scalar features supported by the Node 22 generation. Explicitly deny SIMD and atomics.
  const flags = [
    '--enable-bulk-memory', '--enable-bulk-memory-opt', '--enable-sign-ext', '--enable-mutable-globals',
    '--enable-nontrapping-float-to-int', '--disable-simd', '--disable-relaxed-simd', '--disable-threads', '--print-features',
  ];
  const command = [wasmOpt, wasm, ...flags, '-o', join(scratch, 'validated.wasm')];
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, (result.stderr || 'WASM validator failed').slice(0, 2000));
  assert(WebAssembly.validate(bytes), 'Node rejected scalar WebAssembly');
  const report = {
    at: new Date().toISOString(), wasm, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    validator: spawnSync(wasmOpt, ['--version'], { encoding: 'utf8' }).stdout.trim(), command,
    exitCode: result.status, allowedScalarFeatures: result.stdout.trim().split('\n'),
    simd: false, relaxedSimd: false, threads: false, nodeValidation: true, node: process.version,
    targetValidation: 'Actual LoongArch execution remains unverified; this check validates the portable bytecode on the build host.',
    success: true,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
