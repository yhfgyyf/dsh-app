# DSH App overlays for 0.1.5-rc.1

Apply the core `dsh-local-fixes.patch` before preparing the desktop runtime. Then
`scripts/prepare-runtime.ts` applies audit compatibility, artifact links, sidebar
verification, Computer Use preparation, and progressive image forwarding in that
order. `scripts/build.ts` repeats the overlay checks idempotently.

| Overlay | rc.1 decision | Verification contract |
| --- | --- | --- |
| `audit-compat` | Keep the Host inspect provider leases, audit preset wrappers, and preset-scoped audit dock. These changes are absent upstream. | Pin each whole file and patch SHA-256; validate every target before modifying any target. |
| `artifact-links` | Rebase chat and primitives adapters. The primitives stylesheet binding changed from `css$22` to `css$23`. | The chat `before` SHA is the **core-patched** rc.1 file, including `preview.mediaType`; primitives starts from its official rc.1 package. |
| `sidebar-autoclose` | Retire the alpha patch. rc.1 already collapses the column when its last docked document closes. | Verify the unmodified upstream file by SHA-256; do not overwrite its new guide, history, or floating-pane rules. |
| `progressive-images` | Keep the existing `dsh-progressive-tools@0.3.2` overlay in `patches/progressive-images/manifest.json`. The rebuilt plugin runtime bytes are unchanged. | Verify the existing whole-file pin and exercise image forwarding with the installed rc.1 `createUserMessage` implementation. |

The rc.1 sidebar starts collapsed with no tabs. Expanding an empty sidebar seeds
a guide; its sole guide is protected, and an explicit remaining guide keeps the
column expanded. Floating panes remain available when the docked column
collapses. These are upstream behavior changes from the retired alpha patch.

The clean bootstrap resolves patch paths from `runtime/dependencies.json`, so it
needs no hardcoded alpha path. Plugin source compatibility work under `plugins/`
is documented separately and does not change the pinned published runtime bytes.

After preparing the runtime, run:

```sh
node --test tests/audit-compat.test.ts tests/artifact-links.test.ts tests/sidebar-autoclose.test.ts tests/progressive-images.test.ts
```

The sidebar tests execute the released store and docking engine directly. They
avoid loading the dockkit React barrel, which in rc.1 imports UI dependencies
declared only as package development dependencies. No extra production or test
dependency is needed for these engine tests.

For an isolated runtime, `DSH_OVERLAY_TEST_RUNTIME` selects its package directory
and `DSH_OVERLAY_TEST_CLIENT` selects the renderer package directory. Both must
contain the versions and installed overlays pinned above.
