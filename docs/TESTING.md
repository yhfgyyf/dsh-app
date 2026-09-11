# Verification

Prepare the pinned runtime before testing:

```sh
npm ci
npm run setup:runtime
npm run check
npm run test:model-settings
npm run test:three-surfaces
npm run test:native
npm run test:computer-tools
npm run test:computer-settings
npm run test:computer-native
npm run test:computer-apps
npm run test:audit-switch
npm run test:updates
npm run test:artifact-links
npm run test:sidebar-browser
```

`check` runs TypeScript, unit tests and the renderer/main builds. Unit tests cover
IPC URL boundaries, graph preservation, preferences, resource allowlists and
the pinned DSH frontend adapter. POSIX file-mode assertions run where supported;
Windows stores preferences under the current user's application-data ACLs.

The upgrade checks exercise the released system-prompt projection against the
real Session store: append preserves the existing prefix, a new series or an
incapable model collapses prompts to the head, and clearing removes every active
prompt. RPC regression coverage checks delayed HTTP-server activation, remount
and route disposal. These checks do not measure a provider's KV-cache hit rate.

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

`test:computer-tools` runs the real DSH core, approval service, attachment store,
native tool calls, `invoke_tool`, PTC worker and a local model endpoint. It checks
disabled and enabled App switches under file/shell approval policy `never`,
post-action observations, screenshot bytes reaching model requests and desktop
release, without per-task approval prompts. The native driver is a disposable
fixture in this transport test. Broker tests also cover successive tasks after
one switch enable and cancellation during task startup. Focused action descriptions
must expose only normalized coordinates and App-supported parameters. Regression
tests cover unchanged-frame feedback, consumed observations after native errors,
isolated PiP captures, stale window geometry rejection, validation versus dispatch
failures, exact-window foreground keyboard preparation and clipboard
readback before the explicit macOS paste mode. Paste mode replaces the clipboard.
`test:computer-native` instead loads the actual Cua SDK in Electron and operates
only its own test window using real OS accessibility and input APIs. It verifies
screenshots, accessibility clicks, Unicode text, narrow edge targets with original
and resized observations, window movement, real wheel scrolling and dragging,
and worker process cleanup. The actual PiP window must
update live without taking keyboard focus or replacing native AX/coordinate
state. Its isolated preload rejects foreign windows/frames, and hide/reopen/Stop
controls are exercised. It requires a logged-in interactive desktop
and macOS accessibility/screen-recording grants; missing permissions fail the test.
Reports are `.test-data/computer-tools-latest.json` and
`.test-data/computer-native-latest.json`. The Windows workflow runs both before
building and testing the installer.

`test:computer-apps` is the macOS cross-application regression. It starts a new
factory-empty Blender process and an independent TextEdit process with a temporary
document. Blender's small targets are clicked through the real broker/driver at
1400, 320 and 1600 pixel observation sizes with PiP captures interleaved. The tests
read back Chinese multiline input, selection replacement and a Blender object
created by running the editor text. TextEdit saves typed and pasted Chinese text;
the test compares the actual UTF-8 file. The fixture supplies target geometry and
independent state observations; this tests native delivery, not model visual
localization or planning. Only fixture-owned processes are stopped, and existing
Blender/TextEdit processes must survive. Run desktop tests serially on an unlocked
desktop. Its report is `.test-data/computer-apps-latest.json`; request logs, images
and application state are retained in the report's data directory.

`test:computer-settings` exercises the production renderer, preload, main IPC and
preferences with controlled OS permission/driver outcomes. It checks that the
switch stays off until permissions and startup succeed, disabling persists, and
returning from System Settings refreshes the state. It also renders the actual
packaged Audit component with retained history, switches through all presets,
and verifies that leaving Audit closes its subscriptions. Only native-driver
outcomes and Audit API responses are fixtures; no user permissions are changed.
The report is `.test-data/computer-settings-latest.json`. Every build applies and
hash-verifies the Audit compatibility patch before bundling the runtime.

`test:sidebar-browser` checks the production Electron sidebar: link clicks,
native page bounds, navigation history, dialog visibility, isolated web content,
local HTML/Canvas with relative assets, and renderer cleanup. It uses a local
HTTP fixture and a separate DSH home without making model requests.

`test:artifact-links` replays a synthetic historical session through the actual
desktop UI on both macOS and Windows. It clicks relative, absolute, Unicode and
space-containing file links, and verifies native SVG/PNG/HTML, Markdown, five
Chinese TXT encodings, DOCX text/tables/images, two PPTX slides, XLS/XLSX/ODS
worksheets, quoted CSV cells, WAV metadata and an H.264 MP4 frame. It also checks
damaged/legacy Office messages, document cleanup, sidebar collapse and unchanged
historical log bytes. Word/PowerPoint frames must have no parent-document or
desktop API access. Reports and screenshots are under
`.test-data/artifact-links-native/`; `latest.json` points to the most recent run.
The small committed fixtures need no Office installation or network service.
Unit tests additionally cover encoding overrides, spreadsheet limits, saved
formula values, and Office archive/iframe boundaries.

`test:audit-switch` reproduces the original failure with `--expect-broken` on
an unpatched snapshot. On the fixed runtime it checks concurrent Audit/Cordis
sessions, repeated switching and actual Service/Tool inspection after a switch.
The report is written to `docs/evidence/audit-switch.json`.

For deterministic model/tool integration, start `npm run fixture` in a separate
terminal, then run `npm run test:integration` and `npm run test:tools`. These use
the real DSH services with a local SSE model stub. The advanced tool fixture has
POSIX shell examples; the Windows workflow focuses on unit, model settings,
ownership, native boot and installer behavior.

macOS `npm run package` additionally verifies the complete bundle signature
before and after a ZIP extraction, compares all runtime files and checks exact
app.asar bytes. A successful `codesign` check establishes signature integrity,
not Gatekeeper trust: the default local preview build has no Developer ID or notarization.
First-open testing must retain the browser download quarantine and follow the
normal macOS per-app confirmation if blocked.

### macOS upgrade permissions

The current ad-hoc signature has a designated requirement tied to one build.
macOS can retain an enabled privacy entry for the previous build while rejecting
the new code with `Failed to match existing code requirement`. See Apple's
[code signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).
Packaging records the actual designated requirement and sets
`installedComputerUseVerified: false`; a successful package build does not change
that field to true. The native fixture may inherit a different responsible host's
permissions, so its result does not establish the installed App's TCC access.

For public distribution, follow [Developer ID signing and notarization](MACOS-SIGNING.md).
Use `--developer-id --previous-app <previous-app>` to require a real identity and
check the new bundle against the prior formal signature. The updater repeats that
requirement check before replacing a formally signed installation. Unit tests
cover missing identities and rejected continuity; the signed-to-signed TCC upgrade
test still requires the actual Developer ID certificate and installed builds.

After an upgrade, launch the exact installed App normally from `/Applications`,
enable Computer Use and confirm that its own private worker starts. In that App,
start a task that observes a disposable application window without another
approval prompt, check that the
screenshot and PiP show the current target, then stop the task. Record the installed
version, designated requirement, worker parent process and observation result.
Neither `codesign --verify` nor an enabled row in System Settings replaces this
check. Test builds without a stable signing identity may require these steps
again on the next upgrade; do not weaken the signing requirement to avoid consent.

If logs confirm a stale DSH signing requirement, finish active tasks and quit DSH.
Reset only its affected permission, using `tccutil reset Accessibility io.dsh.desktop`
and/or `tccutil reset ScreenCapture io.dsh.desktop`. This revokes the old grant;
it does not grant access. Relaunch the installed App, use its Computer Use switch,
and authorize that App again in System Settings. If it is absent from the screen
recording list, add `/Applications/DSH Desktop.app` explicitly. Follow macOS's
Quit & Reopen prompt, then repeat the installed-App observation check. Never reset
all applications, write the TCC database, or disable system protections.

Windows packaging additionally runs `scripts/test-windows-installer.ps1`:
silent installation into a path containing spaces; full runtime and app.asar
comparison; bundled Node without system Node on PATH; installed GUI/core boot;
graceful close and core cleanup; silent uninstall and preservation of user data.
It also runs the updater against the installed directory, preserves a complete
previous-app backup, and rechecks the installed runtime before launching it.

All generated data and reports remain in ignored `.test-data`, `.build-runtime`,
`release` and `docs/evidence` directories. The release workflow uploads selected
reports only. These checks do not establish availability of external model
providers, Audit backends, network tools or every input method combination.
# 文件链接与图片预览

运行 `npm run test:artifact-links`。测试使用独立 DSH_HOME 中的历史会话，验证相对路径、绝对路径、带空格的文件名、Markdown 图片与链接、SVG 动画、PNG 缩略图、HTML Canvas、文档查看以及重新加载后的恢复。文件存在性通过实际 `HEAD /api/file` 接口检查；不存在的文件和代码块保持普通文本，不调用外部模型。

该测试也验证关闭最后一个内容标签后侧栏自动收起，以及点击文件重新展开。`node --test tests/sidebar-autoclose.test.ts` 使用实际布局引擎验证“开始”页、分栏、浮动标签、撤销/重做及会话隔离。固定版本补丁在构建和运行时准备阶段自动应用。

## 应用更新

`npm run test:updates` 用独立数据目录和本地 Release 数据验证标题栏小图标、预览版发现、点击下载、校验后重启操作及 IPC 边界，并确认没有更新弹窗或手动检查入口，不调用模型，也不替换用户已安装的 App。`node --test tests/updates.test.ts tests/update-install.test.ts` 验证版本比较、平台选择、下载损坏、重试、进程退出等待以及 macOS 签名校验、备份和失败回退。Electron 中额外验证磁盘上的 `app.asar`，避免将其当作虚拟目录处理。

检查计划测试覆盖启动仅检查一次、每日本地时间、当天去重、并发设置保存和重启恢复。macOS 打包后运行 `node scripts/test-packaged-update.mjs`，在隔离的旧版应用副本上执行启动自动检测、完整下载、退出、外部安装、旧版备份和新版重启，并验证新旧文件哈希、核心启动及用户数据保留。

Windows 安装测试从隔离的已安装旧版窗口点击更新图标，下载完整安装包并点击重启，验证未修改的新版自动启动、原生窗口和核心服务恢复、备份哈希及配置保留。测试期间另一个进程持续映射旧版 `d3dcompiler_47.dll`，覆盖文件占用时更新和回退的情况；失败回退测试还确认旧版重新启动且最初的安装错误不会被回退错误遮盖。

Windows workflow 默认使用 `runtimeSource=registry` 重建固定版本运行时。仅修复更新器且已发布运行时的 DSH 版本与当前依赖清单一致时，才可选择 `runtimeSource=v0.1.5`，恢复后校验全部 26,256 个文件。版本不一致会在下载 CLI 或创建测试 fixture 前明确拒绝，并提示改用 `registry`。CLI 和 TUI 测试仍使用固定版本和提交；应用、更新器和安装包从当前源码重新构建并验证。
