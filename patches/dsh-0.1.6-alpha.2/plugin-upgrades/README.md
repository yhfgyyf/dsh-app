# Reproducible local plugin upgrades

These binary Git patches reproduce the four local plugin snapshots from the
exact repository commits in `runtime/dependencies.json`. They include the local
changes that predated the alpha.2 upgrade, the alpha.2 adaptations, tests, and
committed runtime output. They do not publish packages or move the Git pins.
`node_modules`, Git metadata, and machine-local cache files are excluded.

`manifest.json` identifies every pinned repository and records the patch SHA-256,
each changed path's before/after SHA-256, and its Git file mode. A null digest
means that the path is absent on that side of the patch.

`scripts/bootstrap-runtime.ts` clones and checks out the fixed commits, then
calls `scripts/install-plugin-upgrades.mjs` before applying audit compatibility.
The installer validates all four plugin identities, Git HEADs, patch checksums,
and target file states before writing any target. It rejects unknown or partially
applied changes. It checks every pending Git patch, backs up existing targets,
applies the patches, and verifies the resulting hashes. Already-applied plugins
are accepted without another write.

The exported `applyPluginUpgrades` accepts isolated `pluginRoot` and `backupHome`
directories. Modes are `check`, `apply`, and `verify`; the CLI uses the normal
`.build-runtime/plugins` directory. Verification requires the original pinned
Git checkout, not a published runtime snapshot stripped of its Git metadata.

The original alpha.2 snapshot was verified by cloning all four fixed commits into an
independent directory and applying this installer. All 98 source/runtime files
matched the adapted snapshots byte for byte and by executable mode. The patches
originally changed 23 paths: router 2, audit 10, progressive tools 8, and TUI 3. Checks also
verified backup hashes, missing-upgrade rejection, partial-upgrade rejection,
unknown changes in the fourth plugin preventing writes to the first, and
repeated application preserving file modification times.

The preset resolution fix adds six paths (29 total: router 5, audit 13,
progressive tools 8, TUI 3). Auto and Audit discovery now use the host's
`pluginPackages.packageOf` lookup, matching the official roster. This preserves
both installed profile plugins and bundled runtime dependencies when the root
configuration lives in the desktop profile. Without this lookup, healthy presets
were incorrectly marked broken and existing Auto sessions could not resume.
The added tests retain missing-dependency errors and cover the lookup handoff.
`node scripts/test-audit-switch.mjs` exercises all six modes, shared inspection,
and Auto/Audit session restoration after a cold restart without model calls.
