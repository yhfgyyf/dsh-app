# 麒麟 Browser Use（本机 CDP 接管）

适用目标：麒麟 V10 SP1 2403、LoongArch64 旧 ABI，Desktop 0.1.48 起。保留 DSH 0.2.2-alpha.2、Electron31.7.7、Node22.16 与 Python3.12.14 的移植运行时。用户提供的龙芯 3A6000 实机记录确认 LBrowser 3.4.2577.3 / Chromium138 可开放 CDP；该记录不替代本安装包的实机验收。

## 使用

1. 若日常龙芯浏览器已启动，先正常退出它。不要强制结束或同时启动两个占用同一资料目录的浏览器实例。
2. 从麒麟应用菜单打开“龙芯浏览器（DSH 接管）”，或在图形桌面的终端运行 `dsh-browser-cdp`。该入口使用 `${XDG_CONFIG_HOME:-$HOME/.config}/lbrowser`，沿用已有登录状态，并只将调试服务绑定到 `127.0.0.1:9222`。
3. 在 DSH“设置 → 通用设置”开启“浏览器操作”。设置中显示本机 CDP 模式；不需要安装扩展或填写扩展令牌。
4. 开启后新建或重新打开需要使用 Browser Use 的会话；官方 provider 在会话激活时注册工具，开启前已经打开的会话需重新打开。官方 attach provider 同一时间只允许一个会话使用浏览器。关闭开关会断开 DSH 连接，保留外部浏览器及其登录状态。

可以继续使用已经准备好的 `lbrowser-cdp.sh`，前提是它使用正确的本人 profile，并提供本机 `127.0.0.1:9222` 服务。App 自带路径发现，不再依赖将 `/usr/bin/google-chrome` 软链到 LBrowser。无需手工修改 `resources/runtime/app/browser-use.ts`，升级保留功能实现及原有开关值。

连接失败时，App 会提示先从接管入口启动浏览器。`curl --noproxy '*' http://127.0.0.1:9222/json/version` 应返回 Chromium 版本与本机 WebSocket 地址。未启用调试服务的普通浏览器实例无法被接管；App 不会为此关闭用户浏览器，也不会自动改用干净 profile。

## 桌面与输入法

启动入口继承桌面的 DISPLAY、XAUTHORITY、DBUS_SESSION_BUS_ADDRESS 和 XDG_RUNTIME_DIR，不写死用户名、UID 或 `:0`。GTK/QT/XMODIFIERS 没有配置时才使用 fcitx 默认值。既有的 `dsh-launch-ime.sh` 可继续使用，安装包不覆盖用户的启动脚本。不要从缺少桌面会话环境的 SSH 终端直接启动图形浏览器。

## 范围

CDP 调试服务允许本机进程控制该浏览器，应只在需要接管时使用该启动入口。此版本不下载、构建或预装 Playwright 扩展；Mac/Windows 继续使用原有扩展模式。Chromium 衍生浏览器的 profile 及调试限制可能不同，需以目标 LBrowser 实测为准；Google Chrome136 的默认资料目录调试限制不能直接套用到所有衍生浏览器。
