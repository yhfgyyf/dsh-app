# Codex 协作与手机中继插件

这个插件把现有 DSH 协作流程接入原生 Codex：Skill、51 个 MCP 操作和 CLI 共用同一个本地服务，任务执行使用 `codex app-server`。手机继续通过现有 DSH 中继和 Android 客户端连接。

## 已实现的范围

| 功能 | 实现 |
| --- | --- |
| 注册与身份 | 独立节点注册、CA 指纹校验、短期授权刷新、协作身份恢复、取消注册 |
| 协作空间 | 搜索/筛选/分页、任务与修订历史、引用讨论、候选方案、验证、采纳、直接完成、关注、通知与精确已读 |
| 本地工作 | 草稿、附件上传/下载与 SHA-256 校验、隔离工作目录、原生 Codex 会话、取消、生成文件预览 |
| 持续探索 | 检查点、相同会话的多轮推进、累计 Token/时间预算、暂停/恢复/退出、任务关闭停止、消息隔离 |
| 发布 | 手动、审核、自动三种模式；自动发布保存操作编号，丢失响应后重试不重复发帖 |
| 手机 | 二维码绑定、端到端加密、会话列表/历史/实时输出、文字/图片/文件输入、模型选择、停止、审批/问题答复、断线恢复、撤销绑定 |

复用的协作核心位于仓库的 `src/runtime/collab-*.ts`，手机传输复用 `src/runtime/remote/`。新适配代码集中在本目录。没有新增生产依赖；打包使用项目已有的 Vite、qrcode 和 ws。

## 安装与使用

要求 Node.js 24+ 和兼容的 Codex CLI。当前在 macOS arm64、Node 24.15.0、Codex 0.158.0 上验证。代码采用 POSIX 私有目录；Linux 尚未真机验证，Windows 暂不启用凭据存储。

在本目录执行：

```sh
npm run check
npm run install:local -- --model gpt-6-astra
```

安装器调用 Codex 自带的插件命令，安装 `dsh-codex-collab@dsh-local`，返回安装目录和备份记录。`--model` 只设置桥接服务中新会话的模型，不改主 Codex 的模型设置。这里的模型是在本机实测通过的选项；其他账户可先通过 `codex_models` 查看可用列表。

在加载插件后的新 Codex 会话中，用自然语言要求“使用协作插件查看任务”，即可通过 Skill 和 MCP 工作。已有会话没有发现新插件时，重新打开会话或重启 Codex。安装器不会关闭正在运行的 Codex。

默认数据目录：`~/.local/share/dsh-codex-collab`。可用 `--home DIR` 或 `CODEX_COLLAB_HOME` 指定另一份身份。它与 DSH Desktop 的注册、身份和会话文件分开保存。

首次注册需要中继地址和新的注册码。在 Codex 中提供这两项后使用 `remote_register`。CLI 也支持：

```text
node /absolute/installed/plugin/cli.mjs register --relay https://your-relay --code-stdin
node /absolute/installed/plugin/cli.mjs status
node /absolute/installed/plugin/cli.mjs pair --output /private/path/codex-phone.png
```

注册码从标准输入读取，不放在命令参数中。二维码含有临时绑定凭据，仅展示给自己的手机。不要把注册码、二维码、配置密钥或恢复密钥贴到公共协作任务中。

常用操作与参数见 [Skill](plugin/skills/collaboration/SKILL.md)、[工作流说明](plugin/skills/collaboration/references/workflow.md)，或运行 `cli.mjs tools`。上传本机文件用 `upload PATH`，下载用 `download ID --output NEW_PATH`；下载会验证哈希并拒绝覆盖已有文件。

## 执行与恢复

默认是审核发布、手动继续。持续执行与自动发布需要用户对任务范围和预算的授权；持续执行至少设置一个有限预算。Token 为原生 Codex 的每轮实测汇总，缓存不重复计入，推理 Token 属于输出。运行中的调用可能越过预算阈值；没有用量数据时停止继续，不能记作零。

服务在首次调用时启动，关闭 MCP 调用方后继续执行已经授权的工作。执行机器需要保持开机和联网。进程崩溃后的未结束回合会记为中断，不会自动重发；重新打开插件后可检查状态，再明确恢复。当前不安装开机自启服务。`cli.mjs stop` 停止本数据目录对应的服务和托管工作。

手机只能控制此桥接服务创建的 Codex 会话。现有任意 Codex 窗口不会被接管。DSH 专有的终端、语音、Office、工作区管理等界面不属于此适配器，调用时会返回明确的不支持错误。现有协作 API 则完整复用。手机的协作写操作经已授权的电脑转发，电脑离线时不能执行这些操作。

共享附件上限为 8 MiB；手机图片每张/每批最多 8 MiB、每批最多 8 张。图片保存原始字节和历史引用，检查头部尺寸与格式；完整图片解码由原生 Codex 完成。文件回执绑定会话，只能被同一幂等提示使用一次。

凭据文件和本地密钥保存在权限为 0700 的目录，文件权限为 0600；加密文件的密钥也由同一操作系统用户保存，不属于系统钥匙串。保留整个数据目录才能保留协作身份、草稿、预算和会话历史。

## 卸载与回滚

安装前的 `config.toml`、桥接模型配置、已有插件源，以及安装后的哈希记录保存在 `~/.codex/backups/dsh-codex-collab-*/`。以安装器返回的 `install-record.json` 为准。

先停止本插件服务，再使用 Codex 的原生命令卸载：

```sh
codex plugin remove dsh-codex-collab@dsh-local
codex plugin marketplace remove dsh-local
```

这会保留数据目录和其他 Codex 设置。需要恢复旧插件版本时，使用记录里的 `previousSource`；不要用旧的整份主配置覆盖安装之后发生的其他设置更改。

## 验证

`npm run check` 包含类型检查、组件/中继集成测试、打包以及独立目录安装验证。模型测试单独启用，会使用本机 Codex 登录并消耗模型用量：

```sh
CODEX_COLLAB_MODEL=gpt-6-astra npm run test:native
CODEX_COLLAB_MODEL=gpt-6-astra npm run test:native-collaboration
CODEX_COLLAB_MODEL=gpt-6-astra npm run test:native-image
```

手机协议测试使用实际中继实现和真实加密通道，捕获内容由 Android 自身 DTO 和消息折叠代码解析。测试范围和证据见 [验证记录](VERIFICATION.md)。真实部署的注册与 Android 真机操作分别记录，不能用本地协议测试代替。
