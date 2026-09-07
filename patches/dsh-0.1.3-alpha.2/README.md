# DSH 0.1.3-alpha.2 compatibility patch

The runtime build applies this version-pinned patch to a fresh npm installation.
`manifest.json` records the before/after SHA-256 of all 20 target files and the
unchanged official JSONL persistence implementation. Partial or unknown changes
are rejected; original files are backed up before application.

It preserves session deletion, MP4 storage and `video_url` transport, known
ignorable router diagnostics, and selected legacy event fields during migration.
The headless TUI controller does not require an HTTP upload service. The official
session ownership lock is unchanged; deletion retains the lock file inode.

Run `npm run setup:runtime` from the repository root to build and verify a complete
runtime. For a separate DSH installation, set `DSH_PATCH_GLOBAL_ROOT` to the npm
global `node_modules` directory and run `node apply.mjs --check`, then `--apply`
and `--verify`, after stopping processes using that installation.

DSH and pi-ai retain their upstream MIT licenses, included in the packaged runtime.
