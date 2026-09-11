# Build and package

Use Node 24.15.0 and Git. Run `npm ci`, `npm run setup:runtime`, then
`npm run check`. The runtime builder runs `npm ci --install-strategy=shallow`
with `runtime/dsh/package.json` and its lockfile in `.build-runtime/global`.
The manifest fixes every DSH subpackage to the runtime version and pins the
patch-sensitive `pi-ai` package and tested `zod` version; the lockfile fixes the
remaining dependency graph. Shallow installation keeps DSH's dependencies inside
its package for snapshotting on both platforms. The builder checks out the exact
plugin commits from `runtime/dependencies.json`, applies the hash-guarded patch and snapshots only
published program files into `.runtime`. A previous snapshot is renamed before
replacement. User settings, credentials and sessions are not build inputs.
Existing staging installations and obsolete plugin dependency links are renamed
to backups before replacement. When changing the DSH pin, update its subpackage
overrides and regenerate the runtime lockfile from an empty directory using
`npm install --package-lock-only --install-strategy=shallow --ignore-scripts`.
Verify the pinned patch against a fresh installation before preparing a snapshot.

`npm run prepare:runtime` is the separate snapshot step. For an existing verified
installation, set `DSH_INSTALL_ROOT` to the DSH package directory and
`DSH_PLUGIN_ROOT` to a directory containing the three desktop plugin packages.
The public build uses `setup:runtime` so these machine-local paths are unnecessary.

Computer use is prepared by the same setup step. `runtime/computer-use/driver.json`
pins Cua Driver 0.25.0, its source commit, platform assets and SHA-256 values;
the adjacent npm lockfile pins the SDK and native bridge. `npm run setup:computer-use`
can rebuild this isolated part of `.runtime` without replacing the DSH snapshot.
The downloaded archive is verified before extraction, the driver runs as a private
App-owned worker, and no Cua daemon or updater is installed. Driver telemetry is
disabled. SDK and license files remain outside ASAR with the bundled runtime.
On macOS, preparation builds the worker from that exact source commit with the
small foreground-input patch in `runtime/computer-use/patches`. Install Rust
**1.97.1** and the Xcode Command Line Tools before running preparation. The build
uses the host architecture, a locked Cargo dependency graph, and validates the
source tree, lockfile and patch hashes in `native-patch.json`. `driver-build.json`
records the resulting binary hash. Build and packaging reject a stale or modified
worker; startup requires matching patch metadata. The released SDK and Windows
driver stay pinned to the official assets. A locally installed toolchain under
`.build-runtime/rust` can be used without changing shell profiles.
Build and preparation apply the hash-guarded `invoke_tool` image forwarding patch
in `patches/progressive-images`, retaining an original-file backup.

## macOS

Build on an Apple Silicon Mac with the Swift toolchain and `iconutil`:

```sh
npm run package
```

The package includes its own Node executable and native dependencies. After
packaging, the script applies a complete ad-hoc signature to the Electron app and
helpers. Existing runtime binaries remain byte-identical and are sealed as
resources. It checks every runtime file against the tested snapshot, verifies
the signature with `codesign --verify --deep --strict`, creates the ZIP, then
extracts it and repeats the signature, runtime and app.asar checks.
`release/latest.json` records the artifact path, SHA-256, signature type and
runtime manifest. Ad-hoc signing ensures integrity; it does not provide an Apple
Developer ID or notarization. Downloaded builds may need the per-app Open Anyway
confirmation in System Settings > Privacy & Security.

## Windows x64

Build on Windows x64 with [Inno Setup 7](https://jrsoftware.org/isdl.php), which
supports the long dependency paths in a deeply nested installation directory:

```powershell
npm run package:windows
pwsh -File scripts/test-windows-installer.ps1
node scripts/collect-windows-artifact.ts
```

Set `ISCC_PATH` if the compiler is not installed under
`C:\Program Files\Inno Setup 7\ISCC.exe`. The installer supports Windows
10 build 19041 or later, installs per user, offers Start menu / optional desktop
shortcuts, and keeps user data when uninstalled. The Windows binary is built
with Windows-native dependencies and `node.exe`; a macOS runtime is not reused.

The manual GitHub Actions workflow uses Windows Server 2022, downloads Inno Setup
7.1.0 with a pinned SHA-256, and verifies the
installer in its disposable build environment. It uploads only the installer,
checksums, runtime manifest and test reports. Signing credentials are not
required; resulting packages are unsigned.

Package versions identify the desktop application. The embedded DSH and plugin
versions are pinned separately. Release checksums attest the distributed bytes;
archive timestamps and native tooling can prevent byte-identical rebuilds.

## Audit compatibility in Web/TUI

Apply the Audit compatibility patch to existing Web and TUI profiles backed by
DSH `0.1.5-rc.1`:

```sh
node scripts/install-audit-compat.mjs --check
npm run install:audit-compat
node scripts/install-audit-compat.mjs --verify
```

The installer backs up changed files, rejects unknown runtime/plugin bytes,
verifies SHA-256 and supports repeat runs. Restart the affected Web, TUI or
desktop process to load updated code. Settings, sessions and credentials are
preserved. Use `--home PATH` for a different DSH home; the installer also accepts
`--runtime NODE_MODULES` and `--plugin AUDIT_PACKAGE` for staged runtimes.

The Audit compatibility patch updates the persona to `prefix`/`suffix` and
shares Host inspection providers across mounted presets. The audit bar follows
the current session preset and is hidden outside Audit mode. `setup:runtime` and
`prepare:runtime` apply it before packaging; no external dependency is added.

## Publishing application updates

Bump the version in `package.json` and `package-lock.json`, run the checks, and
build both platform packages from that revision. Publish the exact versioned
ZIP and Windows Setup filenames produced by the packaging scripts. Upload all
assets and checksums to a draft Release before publishing it. The updater reads
the public GitHub releases list, includes published previews, and requires the
matching platform asset's GitHub SHA-256 digest. It does not require a GitHub token.

The installer helper uses the bundled Node copied outside the app directory.
It waits for the app and its owned core to exit. macOS verifies the archive,
bundle identity, version and complete code signature before swapping bundles;
Windows runs the verified Inno installer against the current installation path.
Both keep an old-app backup and preserve DSH_HOME. Installation results are saved
under the desktop application-data directory in `updates/install-result.json`.
