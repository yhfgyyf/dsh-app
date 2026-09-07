# Architecture

`src/main` owns the Electron window, native menus, file dialogs, downloads,
preferences and the lifetime of one embedded DSH child process. `src/preload`
exposes a bounded IPC API. Renderer processes run with context isolation,
sandboxing and web security enabled, without Node integration.

`src/runtime` composes DSH base services, reusable client feature packages and
the pinned local plugins. Its loopback HTTP endpoint carries authenticated RPC,
streams and core assets. It does not serve the official Web App homepage.

`src/renderer` supplies the application's HTML, React entry, loader adapter and
desktop theme. The main process intercepts only its own exact asset allowlist
on the selected loopback origin; remaining requests go to the owned DSH core.
The runtime's client graph is validated before the desktop plugin is added.

The default shared DSH home is the user's `.dsh` directory. Model settings use
DSH's normal settings / credential providers; data is not copied into the app
bundle. `DSH_DESKTOP_CONFIG_HOME` can select an isolated shared home for tests.
`DSH_DESKTOP_DATA_DIR` separately selects the Electron state directory.

Each process uses the official SessionHandle ownership lease. The deletion
patch disposes the owned Agent, drains persistence, acquires an official write
handle, removes session contents and retains the lock inode. Foreign ownership
is reported as a busy error. There is no TTL-based forced takeover.

The packaged runtime is rebuilt for each OS. Native Node and dependency binaries
are copied outside `app.asar`; program files and all original package license
files are retained. Runtime manifests and patch checksums detect mixed versions.
