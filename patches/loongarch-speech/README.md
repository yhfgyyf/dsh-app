# Kylin offline speech (DSH 0.2.0-rc.1)

This packaging overlay is restricted to `runtime.json` declaring `linux/loong64`
and DSH `0.2.0-rc.1`. Mac and Windows retain the upstream native speech provider.
`runtime.patch` is guarded by exact before/after SHA-256 values in `manifest.json`.

The Kylin provider uses locally compiled **scalar WebAssembly**: sherpa-onnx
1.13.8, ONNX Runtime 1.28.2 and Emscripten 4.0.23. The official npm WASM binary
uses SIMD, which the bundled LoongArch Node 22.16.0 does not support. This build
disables SIMD, relaxed SIMD and threads; it does not introduce a native ELF or
glibc dependency. It runs in the existing authenticated, bounded child worker.
Each WASM stream is freed on successful inference and on decoder failure.

The package contains the upstream-pinned INT8 SenseVoice model, tokens and Silero
VAD. Defaults resolve to the provider's `runtime/models`, and retain the upstream
SHA-256 checks. Explicit local model paths remain supported. Missing/corrupted
bundled files, or FP32 without an explicitly supplied model, fail without a
network request. No cloud recognizer, background download or additional service
is added. The SenseVoice weights use the **FunASR Model Open Source License v1.1**;
they must not be described as MIT-licensed weights.

`payload-manifest.json` pins every shipped runtime, model, license and provenance
file. The payload's `speech-provenance.json` records exact upstream revisions,
toolchain archive hashes and the build patches. The upstream `version.cc` itself
hardcodes runtime identifier `8c8e275d`; the actual checked-out sherpa source is
`11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf` (tag v1.13.8). That upstream string was
preserved and is not used as source provenance.

Install into an assembled staging runtime, with local verified sources:

```sh
node scripts/install-loongarch-speech.mjs --target linux-loong64 \
  --runtime-node-modules /absolute/staging/runtime/node_modules \
  --artifact-directory /absolute/scalar-payload \
  --models-directory /absolute/sensevoice/models
node scripts/install-loongarch-speech.mjs --target linux-loong64 \
  --runtime-node-modules /absolute/staging/runtime/node_modules --mode verify
```

The installer performs no downloads and executes no dependency install scripts.
It preserves upstream source backups in the staging runtime and refuses unknown
provider versions or edits. Repeated installation is idempotent. Models and WASM
are intentionally external build artifacts rather than committed binaries.

The [build recipe](build/BUILD.md), [source/toolchain lock](build/source-lock.json),
actual ORT/sherpa source patches and [license sources](build/LICENSE-SOURCES.md)
are included for source review. This recipe builds only the scalar speech runtime;
the complete Kylin application still requires its separately prepared old-ABI
platform runtime and native modules.

`test-worker.mjs PROVIDER_DIRECTORY SYNTHETIC.wav RESULT.json` uses the executing
Node binary to test the actual patched worker, its request validation and default
offline provider inspection. It does not record audio. `test-offline-failures.mjs`
requires an explicit disposable fixture marker before testing missing or corrupt
assets; never run it against an installed application. `validate-scalar-wasm.mjs`
uses Binaryen to reject SIMD/relaxed-SIMD/threads, and also checks Node validation.

Build-host evidence uses macOS Node 22.16.0, a generated five-second WAV and the
real model pair. It does not substitute for LoongArch execution or microphone
testing on the target Kylin machine. The scalar backend is slower than SIMD or
native inference; target performance remains to be measured.
