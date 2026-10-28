# DSH App overlays for 0.1.6-alpha.2

Apply the core patch before runtime preparation. Runtime and renderer overlays
remain independently checksum-pinned; do not copy rc.1 whole-file hashes into
the new manifest.

| Overlay | Decision and contract |
| --- | --- |
| Artifact links | Use official scoped Markdown file navigation, including `#L7` / `#L7-L9`. Collect local destinations for Desktop previews without intercepting that navigation. Keep relative/encoded image resolution, Windows workspace casing, clickable images, legacy local file URI links, and the generated-image gallery. |
| Document source navigation | Keep the one-time `source: true` navigation request. Preserve the official binary suffix filtering, unavailable-format handling, and renderer-owned loading mode. Manual viewer choices survive remount/reload until another source navigation revision arrives. |
| Sidebar autoclose | Verify the official alpha.2 store without rewriting it. It preserves guide, floating-pane, history, and new terminal lifecycle rules while collapsing an empty dock. |
| Audit compatibility | See the separately pinned `audit-compat` bundle. |
| Progressive image forwarding | See `patches/progressive-images/manifest.json`; its before/after pins follow the separately migrated plugin runtime. |

The official Office viewer converts DOC/DOCX/XLS/XLSX/PPT/PPTX to PDF using the
bundled LibreOffice kit and reports missing fonts. Desktop's spreadsheet viewer
still provides sheet selection, cached cell/formula values, and additional
formats such as ODS/CSV/TSV. These are different views of the same document,
not equivalent implementations. Desktop's renderer registration controls their
priority; obsolete DOC/PPT unsupported placeholders must not mask the official
viewer.

The Electron sidebar browser is a user-facing `WebContentsView` with isolated
storage, a restricted local-preview protocol, relative web assets, and explicit
tab cleanup. Official Browser Use supplies agent automation backends; it does
not replace this desktop browsing surface.

Desktop Computer Use retains its session lease, app switch, exact-window
observations, normalized coordinates, automatic post-action observations, and
separate capture worker for picture-in-picture. The official native provider
uses Cua Driver 0.28.0 with its upstream tool catalog and process lifecycle; it
does not reserve a workflow for one Session. Do not enable it beside the
Desktop provider by default. A newer driver version alone is not evidence that
the local 0.25.0 foreground-input patch or its behavior can be removed.

Tests accept `DSH_OVERLAY_TEST_RUNTIME` and `DSH_OVERLAY_TEST_CLIENT` directories
so an isolated alpha.2 Host and alpha.2 renderer can be checked together. The
sidebar test resolves dockkit from the selected client tree rather than an
unrelated installed version.
