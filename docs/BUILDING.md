# Build and package

Use Node 24.15.0 and Git. Run `npm ci`, `npm run setup:runtime`, then
`npm run check`. The runtime builder installs DSH into a repository-owned
`.build-runtime/global` prefix, checks out the exact plugin commits from
`runtime/dependencies.json`, applies the hash-guarded patch and snapshots only
published program files into `.runtime`. A previous snapshot is renamed before
replacement. User settings, credentials and sessions are not build inputs.

`npm run prepare:runtime` is the separate snapshot step. For an existing verified
installation, set `DSH_INSTALL_ROOT` to the DSH package directory and
`DSH_PLUGIN_ROOT` to a directory containing the three desktop plugin packages.
The public build uses `setup:runtime` so these machine-local paths are unnecessary.

## macOS

Build on an Apple Silicon Mac with the Swift toolchain and `iconutil`:

```sh
npm run package
```

The package includes its own Node executable and native dependencies. The script
compares every runtime file with the tested snapshot before producing a ZIP.
`release/latest.json` records the artifact path, SHA-256 and runtime manifest.

## Windows x64

Build on Windows x64 with [Inno Setup 6](https://jrsoftware.org/isinfo.php):

```powershell
npm run package:windows
pwsh -File scripts/test-windows-installer.ps1
node scripts/collect-windows-artifact.ts
```

Set `ISCC_PATH` if the compiler is not installed under
`C:\Program Files (x86)\Inno Setup 6\ISCC.exe`. The installer supports Windows
10 build 19041 or later, installs per user, offers Start menu / optional desktop
shortcuts, and keeps user data when uninstalled. The Windows binary is built
with Windows-native dependencies and `node.exe`; a macOS runtime is not reused.

The manual GitHub Actions workflow uses Windows Server 2022 and verifies the
installer in its disposable build environment. It uploads only the installer,
checksums, runtime manifest and test reports. Signing credentials are not
required; resulting packages are unsigned.

Package versions identify the desktop application. The embedded DSH and plugin
versions are pinned separately. Release checksums attest the distributed bytes;
archive timestamps and native tooling can prevent byte-identical rebuilds.
