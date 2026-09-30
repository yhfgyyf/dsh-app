# Kylin LoongArch compatibility preview

This is a separate, **limited** `0.3.5-kylin.1` plugin build based on the exact
`0.3.5-desktop.1` archive. It does not replace the macOS/Windows package or change
the Desktop app. The full Office feature set is not yet ported.

The base archive SHA-256 and each patch baseline are pinned in `manifest.json`.
The build applies only these changes:

- Gateway and migration workers use `sqlite.cjs`, a small adapter over Node's
  built-in SQLite (available in the existing LoongArch Node 22.16). It maps
  `readonly`, `fileMustExist` and `inTransaction`; all SQL and storage schemas
  remain upstream's. No production dependency is added.
- Three headless runtime registration sites select upstream's existing
  `useRustEngine: false` branch. This uses the bundled JavaScript formula engine.
  Unused Rust materializer exports are left unchanged.
- Remove the three unavailable native dependencies: libsql, formula binding,
  and exchange binding. Declare Node >=22.16 only for this preview variant.
- Office import/export service methods return `KYLIN_EXCHANGE_UNAVAILABLE`
  before opening or writing files. Tool descriptions state the limitation.
  CSV and TSV share the unavailable native converter too.
- Rendering requires an explicit compatible browser path. No default browser
  download is permitted, because Puppeteer maps unknown Linux architectures to
  linux64 and would fetch an x86 browser.

All other files, including the client, remain identical to the reviewed desktop
package. Existing telemetry, DSH rc.1 and right-alignment fixes are retained.

## Build

First build the pinned desktop package using `scripts/prepare-univer-plugin.mjs`.
Then run:

```sh
node scripts/prepare-univer-kylin-plugin.mjs \
  --archive /path/to/dsh-univer-office-0.3.5-desktop.1.tgz \
  --out /path/to/isolated-output
```

The output includes `kylin-provenance.json`, recording every payload file's hash.
The archive does not include an installed dependency tree. `npm pack` runs with
lifecycle scripts disabled. Repeating a build accepts an identical output and
refuses to overwrite a different one. No installed user profile is modified.

## Verify

```sh
node --test tests/univer-kylin-sqlite.test.cjs

DSH_TEST_UNIVER_PLUGIN=/path/to/installed/preview \
DSH_TEST_UNIVER_PROVENANCE=/path/to/kylin-provenance.json \
DSH_TEST_REPORTS=/path/to/isolated-reports \
node scripts/test-univer-kylin-plugin.mjs
```

The host test uses actual DSH 0.2.0-rc.1 tools and a temporary workspace. It places
throwing stubs for all three native packages in the gateway/worker resolution
path; NODE_OPTIONS alone is insufficient because the upstream worker filters it.
It checks calculation and dependent recalculation, all five unit kinds, merge,
restart and exact persisted values. Unsupported operations must fail clearly
without producing a file or modifying the source.

`scripts/test-univer-plugin-upgrade.mjs` also accepts this archive and checks the
real PluginManager in a temporary profile, including rejection of the official
incompatible package and preservation of the telemetry preference.

Run host tests with Node 22.16, including the actual old-ABI LoongArch Node under
QEMU when hardware is unavailable. A test-only launcher can wrap child processes
with QEMU; it must never enter the plugin package. Desktop preview, browser
rendering, fonts, all formula variants and real-machine performance still require
on-device verification. See [installation and test case](INSTALL.zh-CN.md).
