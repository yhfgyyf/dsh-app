# macOS 签名、更新与 Computer Use 权限

每个版本都必须重新签名，但用户不应在每次正常更新后重新授予权限。macOS 通过签名的指定要求（Designated Requirement）识别应用。现有 ad-hoc 包把身份绑定到单个构建的代码指纹，因此旧版本在系统设置中仍显示开启，也不能证明新版本拥有权限。

## 给其他用户分发

1. 由应用维护者加入 Apple Developer Program，生成 **Developer ID Application** 证书。将证书与对应私钥安全保存在构建机钥匙串；用户不需要开发者账号或签名证书。
2. 后续版本保持 `io.dsh.desktop` 和同一开发者团队，并使新版本满足旧版本的指定要求。证书可按 Apple 流程续期，不应改用其他团队、自签名或 ad-hoc 包覆盖正式版本。
3. 签署 Electron、Helper、Node、原生插件和 Computer Use 驱动，启用 Hardened Runtime、安全时间戳，并移除调试用的 `get-task-allow`。本仓库的正式构建会处理这些文件，保留单独的签名前、签后运行时清单，检查其他文件没有变化。
4. 上传 Apple 公证，附加公证票据，重新生成 ZIP 与 SHA-256。签名身份连续用于保留权限；公证用于软件分发和 Gatekeeper 检查，两者不能代替用户首次授权。
5. 在正式签名 App 上测试核心启动、真实截图、点击和画中画，再从同团队签名的旧版更新一次，确认不重新授权也能操作。签名检查、单元测试或开发版驱动测试都不能代替这个验收。

Apple 文档：[签名身份与指定要求](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[Developer ID](https://developer.apple.com/developer-id/)、[公证要求](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。

## 本仓库的构建命令

先在 macOS 钥匙串中安装 Developer ID Application 证书及其私钥。不要把私钥、P12 密码或 Apple 账号密码写入仓库、聊天、日志或普通环境配置。

```sh
security find-identity -v -p codesigning
export DSH_MAC_SIGN_IDENTITY='Developer ID Application: YOUR NAME (TEAMID)'
npm run check
node scripts/package.ts --developer-id --previous-app '/path/to/previous/DSH Desktop.app'
```

`DSH_MAC_SIGN_IDENTITY` 也支持证书的 SHA-1 指纹。证书位于专用钥匙串时，可设置 `DSH_MAC_SIGN_KEYCHAIN` 为其路径。`--previous-app` 应指向上一正式版，用于实际校验签名连续性；首次从 ad-hoc 迁移会明确记录为 `legacy-migration`。正式模式缺少或找不到指定证书时直接失败，绝不回退为 ad-hoc。

未指定正式签名身份的 `node scripts/package.ts` 仍只生成本地 ad-hoc 测试包，构建记录标记 `developerId: false`、`distributionReady: false`，不能将它作为跨版本权限问题的最终修复。

用 `xcrun notarytool store-credentials dsh-release` 按 Apple 提示把公证凭据保存到钥匙串。之后只向脚本提供配置名：

```sh
# 只进行本地检查，不上传。
node scripts/notarize-macos.ts --artifact /path/to/build/artifact.json

# 此命令才会把签名后的安装包上传 Apple 公证，不上传 GitHub。
node scripts/notarize-macos.ts --artifact /path/to/build/artifact.json --submit --profile dsh-release
```

脚本仅接受正式签名构建。公证通过后，在新的 `notarized-*` 目录中附加票据、生成最终 ZIP、验证解压后的签名和 Gatekeeper、重新计算校验和。原始构建保留。`installedComputerUseVerified` 和 `distributionReady` 仍为 false，直到完成真实安装及跨版本权限验收；脚本不会把公证成功冒充功能验收通过。

## 历史 ad-hoc 用户的一次迁移

旧 ad-hoc 身份无法自动继承为新 Developer ID 身份。首次迁移时，用户需要重新登记当前 App 的辅助功能与录屏权限；之后正常更新应保持签名身份。

DSH 会按当前进程的系统权限检查和驱动启动结果显示开关。手动开启失败时，提示缺少的权限、系统设置入口以及“重置 DSH 旧授权”。只有用户点击重置按钮，才执行以下两条限定操作；不会启动时自动清除，也不会影响其他应用：

```sh
tccutil reset Accessibility io.dsh.desktop
tccutil reset ScreenCapture io.dsh.desktop
```

重置是撤销旧授权，不是授予新权限。用户仍需在系统设置中添加 `/Applications/DSH Desktop.app`，开启两项权限，按系统要求退出并重新打开，再验证实际操作。应用不能绕过系统认证。

已经正式签名的 DSH 在安装更新前，会检查新包能否满足当前 App 的指定要求；若不一致，则停止安装并解释原因，避免静默安装导致原权限失效。

## 当前验证边界

当前 macOS 预览包使用 ad-hoc 签名。Computer Use 的真实窗口输入、截图反馈与跨应用回归，以及签名连续性和权限恢复提示的单元测试已通过；这些结果不等同于升级后原授权仍然有效。正式 Developer ID 签名、Apple 公证及正式版本间的权限保留测试尚未完成。安装或更新后，应按 App 显示的权限状态重新检查，并验证实际截图和输入。
