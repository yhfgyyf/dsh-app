# DSH 0.1.5-rc.1 compatibility patch

This bundle applies only to the official `@deepseek-ai/dsh@0.1.5-rc.1` global
installation with its nested dependencies and `@earendil-works/pi-ai@0.85.1`.
`manifest.json` records the original and patched SHA-256 of all 21 target files,
the patch checksum, and the unchanged official JSONL persistence implementation.
Partial application and unknown local changes are rejected. Original target
files are backed up before application.

The alpha.1 patch was compared with the official rc.1 package before migration.
None of its functional changes has been incorporated upstream in rc.1.

| Previous change | rc.1 finding and migration |
| --- | --- |
| Session deletion, RPC descriptors, immediate list removal, workspace cleanup | Still required: rc.1 has no `session/delete`, client delete action, or `forgetSession`. Retained Controller-owned lifecycle disposal, busy/subagent rejection, and lock-preserving log removal. |
| MP4 storage, admission schemas, previews, and `video_url` transport | Still required: the official store and transport remain image-only. Retained byte-preserving MP4 storage, admission, request projection, and client previews. |
| Router diagnostics and legacy event fields | Still required: stock append drops the optional `ignorable` flag; the migration catalog does not recognize `auto-router/classified` or legacy `permission/preset.origin`. Retained the narrow compatibility handling and MP4 migration acceptance. |
| Headless Session Controller without HTTP uploads | Still required: rc.1 retains a hard `fileUploads` dependency and direct calls. Retained optional service lookup, conditional receipt binding, and late resolver registration. |
| Custom RPC channel HTTP-server lifecycle | Still required: rc.1 registers through `owner.webServer` immediately. Retained injected registration, explicit service lookup, and automatic route disposal/re-registration. |
| New rc.1 interfaces | Preserved the official `workspaceDesktop`, reveal-file action, feedback/catalog schemas, `deliverables/presented` and `subagent/catalog` events, `main.conversation`, and workspace navigation changes. Three workspace component parameter conflicts were merged to keep both `usePanelInfo` and the local delete actions. |

The official JSONL writer and lifetime ownership lock remain unchanged. Session
deletion retains the `session.lock` inode. Its rc.1 checksum differs from alpha.1
only because upstream corrected two format-version comments. Two inherited
formatting-only edits were omitted: a trailing tab and an added final newline.

Run `npm run setup:runtime` from the repository root to build a complete runtime.
For a separate global installation, set `DSH_PATCH_GLOBAL_ROOT` to its global
`node_modules` directory and run `node apply.mjs --check`, then `--apply` and
`--verify`, after stopping processes using that installation. A repeated
`--apply` verifies existing target hashes without writing them again.

DSH and pi-ai retain their upstream MIT licenses, included in the packaged runtime.
