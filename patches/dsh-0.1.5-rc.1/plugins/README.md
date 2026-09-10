# Local plugin compatibility with DSH 0.1.5-rc.1

The fixed plugin versions in `runtime/dependencies.json` remain unchanged:
router 0.2.4, Audit 0.6.1, progressive tools 0.3.2, and TUI 0.2.0.
Their production entry points import successfully against the exact official rc.1
package tree. Audit keeps the existing persona and browser UI compatibility
changes from the separate `audit-compat` overlay; progressive image delivery is
owned by the separate image overlay.

The development patch here updates progressive tools to the current type and
fixture API: `ToolCallId`, `ptc`, `snapshotEvents()`, and `tool/ptc-dispatch`.
`JsonValue` is inferred from the existing tool output contract, so no dependency
is added. The rebuilt `lib` files remain byte-identical to the pinned commit.
This patch is **not a runtime installation step**. Apply it with `git apply` in
the pinned progressive tools source checkout before testing that source with
rc.1 dependencies. `manifest.json` records the patch and source hashes.

Validation used disposable copies and rc.1 dependencies:

- Router: `npm run check`, 17 tests passed.
- Audit: `npm run check`, 67 tests passed.
- TUI: `npm run check`, screen, preset, and package checks passed.
- Progressive tools: `npm run check`, typecheck/build, 20 source tests, one
  compiled Loader composition test, and package verification passed.
- Actual official CLI plus custom TUI: all six presets (`standard`, `ptc`,
  `minimal`, `cordis`, `auto`, `audit`) create, mount, and exit successfully using
  the final core compatibility bundle. No model prompt was submitted. The Audit
  case exits immediately and does not validate reviewer completion.

The TUI intentionally retains its existing composition. Stock rc.1 requires
`fileUploads` when mounting SessionController; the core bundle's existing
headless compatibility change is necessary for the TUI. Do not add a second
connection or file-upload workaround to the TUI profile.

The existing local Web/TUI profile manifests still name older progressive
source metadata, but their five deployed production files were byte-identical
to the local 0.3.2 source when verified. Router, Audit, and TUI production files
were also compared with the corresponding local source before staging.
