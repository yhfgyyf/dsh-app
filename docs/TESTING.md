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
npm run test:computer-native
npm run test:audit-switch
npm run test:updates
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
rejected and allowed task grants, screenshot bytes reaching model requests and
desktop release. The native driver is a disposable fixture in this transport test.
`test:computer-native` instead loads the actual Cua SDK in Electron and operates
only its own test window using real OS accessibility and input APIs. It verifies
screenshots, accessibility clicks, Unicode text, a narrow screenshot coordinate
target and worker process cleanup. It requires a logged-in interactive desktop
and macOS accessibility/screen-recording grants; missing permissions fail the test.
Reports are `.test-data/computer-tools-latest.json` and
`.test-data/computer-native-latest.json`. The Windows workflow runs both before
building and testing the installer.

`test:sidebar-browser` checks the production Electron sidebar: link clicks,
native page bounds, navigation history, dialog visibility, isolated web content,
local HTML/Canvas with relative assets, and renderer cleanup. It uses a local
HTTP fixture and a separate DSH home without making model requests.

`test:audit-switch` reproduces the original failure with `--expect-broken` on
an unpatched snapshot. On the fixed runtime it checks concurrent Audit/Cordis
sessions, repeated switching and actual Service/Tool inspection after a switch.
The report is written to `docs/evidence/audit-switch.json`.

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
