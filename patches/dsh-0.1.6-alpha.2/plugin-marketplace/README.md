# Settings plugin marketplace adapter

This patch extends the official `@deepseek-ai/dsh-client-ui-plugin-manager@0.1.6-alpha.2` client. `manifest.json` pins the input, output and patch SHA-256. It accepts either pristine upstream bytes or the exact deployed Desktop 0.1.14 marketplace adapter using a separately pinned migration patch. The installer refuses other versions or unknown edits, verifies a backup before applying, and is idempotent.

The original sidebar Plugins page remains intact. A separate `settings.section` entry, `desktop-plugin-marketplace`, reuses its `PluginManagerController`, snapshot store and `InstallDialog`. Its `plugins.marketplace` list slot receives the current packages, busy/ready status, and official install/enable callbacks. Desktop contributes the discovery UI to this slot only. Both page instances may be mounted concurrently; the controller tracks which surface opened the install dialog so the other page cannot render a duplicate modal.

Search is read-only and uses the authenticated Connection RPC channel `/desktop-marketplace`, endpoint `search`, with `{args:{query,page}}`. Results are exact npm package versions whose published metadata declares `dsh.bundle.patch`. That declaration is not an execution or compatibility test. The UI ignores cancelled/stale responses and displays partial lookup warnings; candidate pagination remains available even when a page contains no verified bundles.

Choosing Install pre-fills `name@version` in the official dialog. After upstream inspect, registry inputs are pinned to its exact returned package name and version. The shared controller requests a DSH report over `/desktop-plugin-security/review`. No report starts installation: users must read it, select the acknowledgement checkbox and explicitly continue. Reports with errors, mismatched identities or no host-issued archive receipt only offer retry/cancel. Reports expire after ten minutes; retries after install-script approval request another report and clear consent. Cancel, replacement and disposal abort pending review/preparation and discard late responses.

On confirmation, `/desktop-plugin-security/prepare-install` revalidates the host-issued receipt. The controller verifies that its spec and SHA-256 match the report, then passes only the returned local archive path to upstream `installBundle`. The visible subject retains the exact npm identity. This ensures a different profile registry cannot substitute an unreviewed same-name package. Installation output, cancellation, build-script permission, failure/retry and Enable now remain upstream-owned. Existing disabled packages use the same official `setEnabled` action. Configuration and uninstall remain on the sidebar Plugins page.

The original `InstallDialog` is registered once as the `plugins.install.dialog` root Factory. Both pages call it through `renderFactorySlot`; it owns the single `plugins.install.review` slot rendered by `src/renderer/plugin-security.tsx`. This follows upstream slot ownership rules without duplicate declarations or separate installers.

Validation:

- `node --test tests/plugin-marketplace-adapter.test.ts`: actual patched controller/slot behavior, single dialog ownership, official inspect delegation, original-byte backup and unknown-edit refusal.
- `node --test tests/plugin-security-adapter.test.ts`: explicit consent, exact-version and archive identity binding, report errors/expiry, cancellation, late responses and install-script retry.
- `node scripts/install-plugin-marketplace.mjs --verify`: exact patched bytes.
- `electron tests/plugin-marketplace.cjs`: actual Settings navigation and isolated local registry lifecycle acceptance; fixtures are authored by the test, not third-party plugins.

Apply during runtime preparation and before renderer builds using the exported `applyPluginMarketplace()` from `scripts/install-plugin-marketplace.mjs`. No new production dependency is required.
