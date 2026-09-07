# Third-party components

DSH Desktop is an independent application and is not an official DeepSeek or OpenAI product.

The distribution includes Electron and DeepSeek Harness (MIT), React (MIT),
Auto Router and Audit (MIT), and Progressive Tools (Apache-2.0), together with
their dependencies. Electron's license and Chromium notices accompany its
distribution. Package license files are retained under `resources/runtime/node_modules`
on Windows and `Contents/Resources/runtime/node_modules` on macOS.

The version-pinned modifications under `patches/` adapt the MIT-licensed DSH and
pi-ai components. Their original licenses remain applicable. Exact runtime and
plugin revisions are listed in `runtime/dependencies.json`; installer checksums
are provided with each GitHub Release.
