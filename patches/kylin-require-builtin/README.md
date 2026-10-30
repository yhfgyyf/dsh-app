# Kylin old-world require-builtin port

DSH 0.2.2-alpha.2 loads node-addon-require-builtin while preparing profile resolution. The old Kylin runtime removed the unsupported native package, which left a required dependency missing and prevented Host startup. Desktop package 0.1.45-2 restores the upstream 0.1.9 JS entry and supplies a nodeabi/node-v127 LoongArch binary for the bundled Node22.16.

The patch adds a strict decoder for the actual pinned runtime getter and a LoongArch diagnostic label. It derives the field displacement from validated instructions and retains upstream mapped-memory, runtime-image, pointer, handle and N-API validation. Unknown instruction patterns fail closed. Only official public Node22.16 headers are used. The official optional-package matrix is unchanged; the validated binary uses upstream's local-build loading path.

`manifest.json` pins the upstream commit, native hash and complete [source/build-input archive](https://github.com/yhfgyyf/dsh-app/releases/download/v0.1.45/node-addon-require-builtin-0.1.9-loongarch-source.tar.gz). The archive includes public header checksums, node-addon-api8.9, the exact cross-compiler command and package assembly procedure. `decoder-test.cc` covers 14 positive/negative instruction and memory cases.

Before every Kylin release, extract the final DEB and run:

```sh
node tests/kylin-host-smoke.mjs /path/to/extracted/resources/runtime /path/to/loongarch-node-or-qemu-wrapper /new/empty/test-directory
```

The wrapper must run the final extracted Node22.16 executable and preserve child-process IPC; the recorded QEMU setup redirects child execPath only for emulation. Require a passing report: 101 root dependencies, native module and Worker, full Host start/restart with 71 modules, authenticated workspace/session API, persistence, anonymous profile manifest and clean shutdown. Archive integrity or ELF checks alone do not prove startup.

The final 0.1.45-2 DEB passed these QEMU checks. All 92 ELF files are ABI1/glibc<=2.28; the prior 91 native files are unchanged. Physical Kylin Chromium GUI remains untested, and this Node22 port is below upstream's Node>=24.9 requirement.
