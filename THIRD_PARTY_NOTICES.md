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

Computer use includes Cua Driver and its Node SDK 0.25.0 (MIT), pinned to
`trycua/cua` commit `45d78fedcf2c7033ba33f10dd30f8af8ba31ec3f`.
Its native Node bridge is derived from UniFFI Bindgen React Native 0.31.0-3
(MPL-2.0), as are the bundled `@ubjs/core` and `@ubjs/node` runtimes.
The original bridge notice is retained in its platform package. License texts
are included under `runtime/computer-use/licenses` in the application resources.
Corresponding source and the deterministic bridge build transformations are
available in the [Cua release source](https://github.com/trycua/cua/tree/cua-driver-rs-v0.25.0)
and [UniFFI source](https://github.com/jhugman/uniffi-bindgen-react-native).
Driver archives are verified against the SHA-256 pins in
`runtime/computer-use/driver.json`; npm packages use the accompanying lockfile.
