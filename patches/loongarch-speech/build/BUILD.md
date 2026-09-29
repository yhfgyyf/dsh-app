# Scalar speech runtime build record and recipe

This recipe builds the speech WASM component used by DSH Desktop 0.1.28. It
parameterizes the accepted commands without changing their source patches or
CMake flags. The build host was macOS arm64, Python 3.12.14 and Node 22.16.0.
`source-lock.json` records primary commits, the official Emscripten archive hash,
build tool versions and modified-source before/after hashes. The read-only
`--check` passed against that actual workspace. The parameterized script has not
been used to rebuild the release; byte-identical output is not claimed.

This is **not a complete Kylin application build command**. Old-ABI Kylin V10 SP1
also requires the existing verified LoongArch Electron 31.7.7, Node 22.16.0,
glibc 2.28-compatible native modules and Python runtime. These platform components
and the application assembly remain separate inputs. Neither this script nor the
standard Windows packaging command creates them.

## Prepare and compile

Use a fresh work directory outside the repository. Prerequisites are Git, curl,
tar, a macOS arm64 Node 22.16.0 executable and Python 3.12.14. The isolated SDK and
virtual environment do not change the global SDK or system Python.

```sh
recipe="$PWD/patches/loongarch-speech/build"
work_dir="/path/to/empty/scalar-build-workspace"
node_bin="/path/to/node-v22.16.0-darwin-arm64/bin/node"
python_bin="/path/to/python3.12"
mkdir -p "$work_dir"
"$python_bin" -m venv "$work_dir/build-python"
"$work_dir/build-python/bin/python" -m pip install -r "$recipe/requirements-build.txt"

"$work_dir/build-python/bin/python" - "$recipe" "$work_dir" <<'PY'
from pathlib import Path
import json, subprocess, sys
recipe, work = map(Path, sys.argv[1:])
lock = json.loads((recipe / 'source-lock.json').read_text())
for directory, source in lock['sources'].items():
    target = work / directory
    subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout', source['url'], str(target)], check=True)
    subprocess.run(['git', '-C', str(target), 'checkout', '--detach', source['commit']], check=True)
PY

archive="$work_dir/emsdk/downloads/aaa43392544d695232b70eda706d751f18980c2a-wasm-binaries-arm64.tar.xz"
mkdir -p "$work_dir/emsdk/downloads" "$work_dir/emsdk/upstream"
curl --fail --location --retry 5 --output "$archive" \
  https://storage.googleapis.com/webassembly/emscripten-releases-builds/mac/aaa43392544d695232b70eda706d751f18980c2a/wasm-binaries-arm64.tar.xz
"$work_dir/build-python/bin/python" - "$recipe" "$archive" <<'PY'
from pathlib import Path
import hashlib, json, sys
lock = json.loads(Path(sys.argv[1], 'source-lock.json').read_text())['toolchain']
archive = Path(sys.argv[2])
assert archive.stat().st_size == lock['bytes']
with archive.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == lock['sha256']
PY
tar -xf "$archive" --strip-components=1 -C "$work_dir/emsdk/upstream"

git -C "$work_dir/ort-scalar-source" apply "$recipe/ort-build-driver.patch"
git -C "$work_dir/sherpa-onnx" apply "$recipe/sherpa-scalar.patch"
git -C "$work_dir/onnx-source" apply "$work_dir/ort-scalar-source/cmake/patches/onnx/onnx.patch"
rmdir "$work_dir/ort-scalar-source/cmake/external/emsdk"
ln -s "$work_dir/emsdk" "$work_dir/ort-scalar-source/cmake/external/emsdk"

bash "$recipe/build-scalar.sh" "$work_dir" "$node_bin" --check
bash "$recipe/build-scalar.sh" "$work_dir" "$node_bin" > "$work_dir/build.log" 2>&1
```

`rmdir` above applies to the empty, uninitialized SDK submodule in the fresh
checkout and refuses a populated directory. CMake fetches its remaining
upstream-pinned build dependencies. The original build used sparse checkout to
reduce transfers; a full checkout avoids the missing-header repairs that were
needed there and does not change compiled sources.

## Patches and output

- `ort-build-driver.patch` skips only ORT's unconditional SDK install/activate.
  Explicit `EM_CONFIG`, the checked compiler archive and the isolated cache
  replace that setup; ONNX inference code is unchanged.
- `sherpa-scalar.patch` substitutes the local scalar ORT archive for the SIMD
  prebuilt archive. It is byte-for-byte the actual accepted patch. Removed lines
  include upstream example paths, not local user configuration.
- ONNX receives the official patch in pinned ORT source; its hash and the two
  resulting source-file hashes are recorded in the lock.
- ORT sets SIMD, relaxed SIMD and threads OFF. Sherpa uses `-mno-simd128`, TTS
  OFF and the upstream Node WASM settings. No LoongArch ELF is generated here.
- Final JS/WASM and helpers are in `sherpa-scalar-install/bin/wasm/nodejs/`.
  The ORT static archive is a build intermediate and is not shipped.

Runtime assembly uses those compiled files plus the CommonJS `index.js` from
`https://registry.npmjs.org/sherpa-onnx/-/sherpa-onnx-1.13.8.tgz`, whose SHA-256 is
`15dc53065cc6bbc73ddbb1b216bccb5660233b7626460d7c62baf78e7f3c3f43`.
**Do not copy the npm archive's original SIMD JS/WASM.** The custom package is
named `sherpa-onnx-dsh-kylin-scalar@1.13.8-dsh.scalar.1`; preserve the upstream
author/license metadata and omit install/test hooks. Include notices listed in
`LICENSE-SOURCES.md` and `../payload-manifest.json`. The same manifest contains
the three unmodified model URLs, revisions and hashes. Weights and binaries are
external build/package inputs, not committed source.

## Validation and release scope

```sh
"$node_bin" "$recipe/../validate-scalar-wasm.mjs" \
  "$work_dir/sherpa-scalar-install/bin/wasm/nodejs/sherpa-onnx-wasm-nodejs.wasm" \
  "$work_dir/emsdk/upstream/bin/wasm-opt" "$work_dir/scalar-validation.json"
```

Assemble an isolated provider with `scripts/install-loongarch-speech.mjs` and run
the worker, offline-failure and installer verification described in the parent
README. The synthetic fixture is 16 kHz mono PCM16 WAV, saying “Hello world. This
is a local speech recognition test.” No microphone recording is required.

The release WASM hash is locked. Build paths/toolchain metadata can change a
rebuild's bytes, so the shipping manifest intentionally rejects a different
artifact. Before updating pins, record new provenance and pass scalar feature
validation, real worker transcription and offline failure tests. The original
Kylin machine was unreachable: target V8, microphone and performance still need
on-device verification.
