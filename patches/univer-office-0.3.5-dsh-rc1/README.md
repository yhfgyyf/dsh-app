# Univer 0.3.5 compatibility package for DSH 0.2.0-rc.1

This repository produces `dsh-univer-office@0.3.5-desktop.1` from the official
`dsh-univer-office@0.3.5` npm archive. It is a Desktop compatibility build, not an
upstream release. The complete upstream archive hash and every changed file's
before/after hash are pinned in `manifest.json`. Runtime dependencies are unchanged.

The four changed files:

- `package.json`: append **exactly** `0.2.0-rc.1` to the seven DSH peer ranges and
  distinguish the compatibility version. No compatibility exemption is written.
- `lib/index.js`: default both config validation and runtime telemetry to `false`;
  preserve the existing local `right` alignment alias in model-facing API docs.
- `lib/client.js`: export the plugin name so rc.1 owns its client contributions.
  Upstream 0.3.5 already handles V4 tool messages and explicitly names its list
  slot contribution. Giving it a name also avoids Desktop's older V3 adapter.
- `artifacts/unit-content-worker.mjs`: retain `right` as an alias of `normal`,
  both mapping to `HorizontalAlign.RIGHT`. Getter behavior remains `normal`.
  Invalid alignment values still throw. The unmodified 0.3.5 worker was verified
  to reject `right`; simply widening the peer ranges would regress this local fix.

The API/resource query arrays already include `items: { type: 'string' }` in
upstream 0.3.5. Its tool catalog no longer exposes the earlier batch `files`
argument, so no obsolete schema patch is applied. Browser/render assets stay
unchanged. The large embedded API document is patched with the small, hash-pinned
`alignment-replacements.json`, rather than committing a generated multi-megabyte
bundle diff. The worker diff is also retained for review.

## Build

With Node.js, npm and `tar` available:

```sh
node scripts/prepare-univer-plugin.mjs --out .test-data/univer-package
```

An existing official archive can be supplied with `--archive /path/to/dsh-univer-office-0.3.5.tgz`.
`--npm-cli /path/to/npm-cli.js` selects the build machine's npm when it cannot be
located automatically. The script verifies the complete archive before extracting,
checks every patch baseline and output, verifies all other package files remain
unchanged, and packages with lifecycle scripts disabled. Repeating the same build
accepts an identical output; a different existing output is refused. It does not
inspect or modify any DSH user profile. Generated bundles and archives stay out of Git.

## Validation

`scripts/test-univer-plugin-upgrade.mjs` tests the actual core PluginManager in a
disposable profile: the unmodified official plugin is rejected, the local package
replaces it, telemetry configuration is preserved, and a subsequent startup accepts
it without `compatibility.json`.

`scripts/test-univer-plugin-host.mjs` accepts `DSH_TEST_RUNTIME`,
`DSH_TEST_UNIVER_PLUGIN` (an installed package with its dependencies), and
`DSH_TEST_REPORTS`. It uses an isolated workspace and actual rc.1 ToolRuntime,
Gateway and worker. It validates the new native dependencies at 1.0.1, 13 tool
registrations, array schema rejection, all eight skills, and nine real calls for
creating a file/worktree/sheet, writing cells, right/normal alignment, rejecting an
invalid value, and reading unchanged data. It makes no model request. Screenshot,
PPTX import/export, and interactive browser behavior are outside this regression.

The existing `tests/univer-client.cjs` accepts `DSH_TEST_UNIVER_PACKAGE` for this
candidate, checks its manifest hashes, and exercises the real Desktop loader and
preview slots. Windows validation must run on Windows to verify the new native
dependencies; a macOS pass is not Windows evidence.

## Install or roll back

In DSH's plugin settings, add the generated `.tgz` as a local plugin package,
then restart DSH when prompted. This updates the plugin; it does not require a new
Desktop installer. Keep the old package if rollback is needed. A rollback to the
official 0.3.5 or older 0.3.2 package also requires a DSH core version accepted by
that package's peer dependencies. Do not bypass rc.1's compatibility check.
