# Desktop file links

The chat adapter passes the owning session's working directory and existing
sidebar file opener to the desktop Markdown component. The Markdown adapter
allows that component's verified file vocabulary to handle authored links and
inline images, in addition to inline-code paths. HTTP links retain their existing
behavior; raw HTML and fenced code remain inert.

`src/renderer/artifact-markdown.tsx` checks otherwise unrecognized paths using the
existing authenticated `HEAD /api/file` endpoint. Successful references become
file links, and image paths in completed replies receive clickable thumbnails.
This also handles historical replies and files generated through `run_code` or a
shell without changing session records or inferring commands from model output.

`scripts/install-artifact-links.mjs` backs up and verifies the two package files.
It accepts only the recorded pre/post hashes and is idempotent. Runtime preparation
and builds apply it automatically; `--verify` checks it without writing files.
The chat preimage includes the existing 0.1.5 local fixes.
