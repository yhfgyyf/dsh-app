# DSH 0.2.0-rc.1 desktop compatibility

Rebased against the official 0.2.0-rc.1 npm runtime, without replacing upstream files wholesale. Every applied file and patch retains strict before/after SHA-256 verification; the official lifetime persistence lock implementation is unchanged.

- Core: retain local session deletion/lifecycle ownership, byte-preserving MP4 attachments, router diagnostic history, and optional Host file-upload/Web transports.
- Artifact links: retain Windows case-insensitive workspace addresses, local preview collection, and explicit document source navigation. Use the new upstream fileMediaUrl, Markdown image preview/lightbox and image-link hover cards; do not restore the previous nested image-button override.
- Attachment previews: preserve the upstream image lightbox moved to primitives; MP4 uses the shared upstream Modal.
- Plugin marketplace: retain Settings discovery and optional model review, direct-install archive verification and review-to-install digest binding. Preserve upstream registry diagnostics, peer-version refusal, IME handling, refresh notifications and navigation store.
- Audit compatibility and sidebar autoclose: no local edits; use official Host Cordis inspection and sidebar behavior. Their manifests pin the audited upstream baseline.

Migration evidence and focused checks: `reports/upgrade-0.2.0-rc.1-20260929/overlays-audit.md` in the local DSH home.
