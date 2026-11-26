#!/usr/bin/env bash
# Build the Node SDK used by the Kylin package on an x86_64 Linux build host.
# Inputs are the Node source archive, the old-world cross toolchain archive and a new build directory.
set -euo pipefail
node_source=$(realpath "${1:?Node v24.22.3 source .tar.xz required}")
cross_archive=$(realpath "${2:?x86_64 glibc oldworld cross-tools .tar.xz required}")
work=$(realpath -m "${3:?new build directory required}")
mkdir -m 700 "$work"
cd "$work"
printf '%s  %s\n' 48ca3aa8a9b02133356922ef4fc80200e00598c80a4ef446f7c39a459222593d "$node_source" \
  4aa49ed1164c92ed347af8d3e2f9f870ee5298b9417e9314353f0f41fa2a0309 "$cross_archive" | sha256sum -c -
mkdir cross
tar -xJf "$cross_archive" -C cross --strip-components=1
tar -xJf "$node_source"
export PATH="$work/cross/bin:$PATH"
export CC=loongarch64-unknown-linux-gnu-gcc CXX=loongarch64-unknown-linux-gnu-g++ AR=loongarch64-unknown-linux-gnu-ar
export CC_host="${CC_host:-gcc-12}" CXX_host="${CXX_host:-g++-12}" AR_host=ar LC_ALL=C
cd node-v24.22.3
./configure --dest-cpu=loong64 --dest-os=linux --cross-compiling --partly-static \
  --without-node-snapshot --without-node-code-cache --openssl-no-asm
# Node's --partly-static leaves libatomic dynamic. Keep that GCC runtime in the executable as well.
python3 - <<'PY'
from pathlib import Path
p = Path('out/node.target.mk')
contents = p.read_text()
assert contents.count('-latomic ') == 1
p.write_text(contents.replace('-latomic ', '-Wl,-Bstatic -latomic -Wl,-Bdynamic '))
PY
make -j"${JOBS:-8}"
python3 tools/install.py install --dest-dir "$work/sdk" --prefix / --silent
cp LICENSE README.md CHANGELOG.md "$work/sdk/"
loongarch64-unknown-linux-gnu-strip --strip-debug "$work/sdk/bin/node"
readelf -h "$work/sdk/bin/node" | grep 'Flags:.*0x3,'
readelf -l "$work/sdk/bin/node" | grep -F '/lib64/ld.so.1]'
if readelf -d "$work/sdk/bin/node" | grep -Eq 'libatomic|libstdc\+\+|libgcc'; then exit 1; fi
(cd "$work" && sha256sum sdk/bin/node)
