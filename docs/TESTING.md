# Verification

Prepare the pinned runtime before testing:

```sh
npm ci
npm run setup:runtime
npm run check
npm run test:model-settings
npm run test:three-surfaces
npm run test:native
```

`check` runs TypeScript, unit tests and the renderer/main builds. Unit tests cover
IPC URL boundaries, graph preservation, preferences, resource allowlists and
the pinned DSH frontend adapter. POSIX file-mode assertions run where supported;
Windows stores preferences under the current user's application-data ACLs.

`test:model-settings` runs two independent cores with disposable settings and
fake credentials. It checks provider discovery, defaults, updates, persistence,
credential deletion and concurrent writes without calling a model service.

`test:three-surfaces` runs an actual Web CLI, TUI CLI and DesktopRuntime against
one disposable home. It checks shared listing, foreign-write/deletion rejection,
log stability, exit handoff, TUI export, own-session deletion, competing TUI
processes and ownership release after a crash.

`test:native` boots Electron and the independent core, inspects its IPC and
transport contracts, checks exact frontend bytes, injects a core failure and
verifies recovery and process cleanup. It uses its own data directory.

For deterministic model/tool integration, start `npm run fixture` in a separate
terminal, then run `npm run test:integration` and `npm run test:tools`. These use
the real DSH services with a local SSE model stub. The advanced tool fixture has
POSIX shell examples; the Windows workflow focuses on unit, model settings,
ownership, native boot and installer behavior.

macOS `npm run package` additionally verifies the complete ad-hoc signature
before and after a ZIP extraction, compares all runtime files and checks exact
app.asar bytes. A successful `codesign` check establishes signature integrity,
not Gatekeeper trust: the preview build has no Developer ID or notarization.
First-open testing must retain the browser download quarantine and follow the
normal macOS per-app confirmation if blocked.

Windows packaging additionally runs `scripts/test-windows-installer.ps1`:
silent installation into a path containing spaces; full runtime and app.asar
comparison; bundled Node without system Node on PATH; installed GUI/core boot;
graceful close and core cleanup; silent uninstall and preservation of user data.

All generated data and reports remain in ignored `.test-data`, `.build-runtime`,
`release` and `docs/evidence` directories. The release workflow uploads selected
reports only. These checks do not establish availability of external model
providers, Audit backends, network tools or every input method combination.
