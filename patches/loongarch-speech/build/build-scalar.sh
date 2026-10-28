#!/usr/bin/env bash
# Parameterized form of the commands used for the accepted 0.1.28 scalar payload.
set -euo pipefail
if [[ $# -lt 2 || $# -gt 3 || ( $# -eq 3 && "$3" != --check ) ]]; then
  echo 'Usage: bash build-scalar.sh WORK_DIRECTORY NODE_22_EXECUTABLE [--check]' >&2
  exit 2
fi
dsh_recipe=$(cd -- "$(dirname -- "$0")" && pwd)
dsh_wasm_root=$(cd -- "$1" && pwd)
dsh_node=$2
dsh_python="$dsh_wasm_root/build-python/bin/python"

# Read-only preflight: refuse changed sources, patches, compiler archive or build dependencies.
"$dsh_python" - "$dsh_recipe" "$dsh_wasm_root" "$dsh_node" <<'PY'
from pathlib import Path
import hashlib, importlib.metadata, json, platform, subprocess, sys
recipe, root, node = map(Path, sys.argv[1:])
lock = json.loads((recipe / 'source-lock.json').read_text())
def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
assert node.is_absolute(), 'Node executable must be an absolute path'
assert platform.system() == 'Darwin' and platform.machine() == 'arm64', 'This locked compiler archive is for a macOS arm64 build host'
assert platform.python_version() == lock['verifiedBuildHost']['python'], 'Python version differs'
assert subprocess.check_output([str(node), '--version'], text=True).strip() == 'v' + lock['verifiedBuildHost']['node'], 'Node version differs'
for directory, source in lock['sources'].items():
    revision = subprocess.check_output(['git', '-C', str(root / directory), 'rev-parse', 'HEAD'], text=True).strip()
    assert revision == source['commit'], 'Source revision differs: ' + directory
for entry in lock['sourcePatches']:
    patch = entry['patch']
    path = recipe / patch['recipeFile'] if 'recipeFile' in patch else root / patch['sourceDirectory'] / patch['path']
    assert digest(path) == patch['sha256'], 'Patch checksum differs: ' + str(path)
    for source in entry['files']:
        assert digest(root / entry['directory'] / source['path']) == source['after'], 'Expected prepared source differs: ' + source['path']
archive = root / 'emsdk/downloads' / (lock['toolchain']['release'] + '-wasm-binaries-arm64.tar.xz')
assert archive.stat().st_size == lock['toolchain']['bytes'] and digest(archive) == lock['toolchain']['sha256'], 'Compiler archive checksum differs'
assert (root / 'emsdk/upstream/emscripten/emscripten-version.txt').read_text().strip() == '4.0.23-git', 'Extracted compiler version differs'
assert (root / 'ort-scalar-source/cmake/external/emsdk').resolve() == (root / 'emsdk').resolve(), 'ORT must use the isolated SDK'
for name, version in lock['pythonPackages'].items():
    assert importlib.metadata.version(name) == version, 'Build package version differs: ' + name
print('Verified locked sources, applied patches and isolated build toolchain')
PY
if [[ ${3:-} == --check ]]; then exit 0; fi

export EM_CONFIG="$dsh_wasm_root/emscripten-config.py"
export EMSDK="$dsh_wasm_root/emsdk"
export EMSDK_NODE="$dsh_node"
export EMSDK_PYTHON="$dsh_python"
export PATH="$dsh_wasm_root/build-python/bin:$dsh_wasm_root/emsdk/upstream/emscripten:$PATH"
"$dsh_python" - "$dsh_wasm_root" "$dsh_node" <<'PY'
from pathlib import Path
import sys
root, node = sys.argv[1:]
values = {'LLVM_ROOT': root + '/emsdk/upstream/bin', 'BINARYEN_ROOT': root + '/emsdk/upstream',
          'NODE_JS': [node], 'CACHE': root + '/emscripten-cache'}
Path(root, 'emscripten-config.py').write_text(''.join(f'{key} = {value!r}\n' for key, value in values.items()))
PY

cd "$dsh_wasm_root/ort-scalar-source"
"$EMSDK_PYTHON" tools/ci_build/build.py \
  --config Release --update --build --parallel 8 --skip_tests --skip_submodule_sync \
  --build_dir "$dsh_wasm_root/ort-scalar-build" \
  --build_wasm --build_wasm_static_lib --emsdk_version 4.0.23 --cmake_generator Ninja \
  --cmake_extra_defines \
  onnxruntime_BUILD_UNIT_TESTS=OFF \
  onnxruntime_ENABLE_WEBASSEMBLY_SIMD=OFF \
  onnxruntime_ENABLE_WEBASSEMBLY_RELAXED_SIMD=OFF \
  onnxruntime_ENABLE_WEBASSEMBLY_THREADS=OFF \
  onnxruntime_ENABLE_CPUINFO=OFF \
  FETCHCONTENT_SOURCE_DIR_ONNX="$dsh_wasm_root/onnx-source" \
  CMAKE_POLICY_VERSION_MINIMUM=3.5

export SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON
cmake -G Ninja -S "$dsh_wasm_root/sherpa-onnx" -B "$dsh_wasm_root/sherpa-scalar-build" \
  -DCMAKE_INSTALL_PREFIX="$dsh_wasm_root/sherpa-scalar-install" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$dsh_wasm_root/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DDSH_SCALAR_ORT_INCLUDE="$dsh_wasm_root/ort-scalar-source/include/onnxruntime/core/session" \
  -DDSH_SCALAR_ORT_LIBRARY="$dsh_wasm_root/ort-scalar-build/Release/libonnxruntime_webassembly.a" \
  -DCMAKE_C_FLAGS=-mno-simd128 -DCMAKE_CXX_FLAGS=-mno-simd128 \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF -DSHERPA_ONNX_ENABLE_WASM=ON \
  -DSHERPA_ONNX_ENABLE_WASM_NODEJS=ON -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_ENABLE_TTS=OFF -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF
cmake --build "$dsh_wasm_root/sherpa-scalar-build" --parallel 8
cmake --install "$dsh_wasm_root/sherpa-scalar-build"
