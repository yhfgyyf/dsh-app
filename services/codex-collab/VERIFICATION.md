# 验证记录

日期：2026-10-07（Asia/Taipei）。环境：macOS arm64，Node 24.15.0，原生 Codex 0.158.0。

| 检查 | 结果与边界 |
| --- | --- |
| 本插件组件和真实本地中继集成 | 17 项通过。包括注册/恢复、CLI/MCP 完整协作流程、单写入进程、持续推进、预算、丢失响应后的幂等发布、审批、回合隔离、图片/文件历史。模型进程使用确定性测试替身。 |
| 原生 Codex 会话 | 三轮实际模型调用通过；第二轮更换工作目录，第三轮重启进程后恢复同一线程。累计实测 169,483 Token。见 `artifacts/native-smoke.json`。 |
| 原生 Codex 协作任务 | 最终适配代码和本机插件安装完成后再次通过：实际模型经协作流程生成 `answer.txt`、提交与检查点；审核模式没有发布公共回复，文件与实测用量检查通过。见 `artifacts/native-collaboration.json`。 |
| 原生 Codex 图片输入 | 实际模型识别测试二维码，图片保留为手机可读取的会话引用，原始字节读回一致。见 `artifacts/native-image.json`。 |
| 手机加密协议 | 本地中继实现上的二维码绑定、加密 HTTP/WebSocket、实时流、审批答复、图片/文件、历史分页、重连、取消和撤销绑定通过。见 `artifacts/phone-wire.json`。 |
| Android 协议兼容 | `:core:test --tests '*CodexBridgeFixtureTest'` 通过，使用当前协议捕获验证 Android DTO、图片/文件内容、历史折叠和实时消息恢复。 |
| 现有协作与远程模块 | 98 项相关测试已覆盖通过。最终共享改动后的协作测试和权限测试共 87 项重新通过，其余 11 项复用未改动状态下的通过结果。 |
| 中继 | 类型构建与 108 项测试通过；部署中的中继未改动。 |
| 独立安装包 | 独立目录运行、原生 Codex 发现 Skill/51 个 MCP 操作、安装与卸载保留原设置的 2 项测试通过。测试包含安装器修改后的启动清单和工作进程禁用自身 MCP 工具，避免递归调用。 |
| 本机实际安装 | Codex 0.158.0 发现 Skill 与全部 51 个工具。安装清单使用插件内启动入口，兼容原生加载器；桥接工作进程没有可调用的自身 MCP 工具。见 `artifacts/local-install-smoke.json`。 |
| 实际中继 | 用户指定的 `https://58.211.58.111:28443` 注册、CA 校验、在线连接、身份/恢复验证、MCP 读取现有 3 个任务通过。服务重启后保持同一身份；线上任务写入为 0。见 `artifacts/real-relay-smoke.json`。 |
| 类型与构建 | 插件与主项目类型检查、生产构建通过；Skill 校验通过。主项目构建仍有已有的 PPTX `import.meta` 和包体积提示。 |

原生测试使用本机已有登录，没有复制其身份凭据到中继。主 Codex 配置中的 `gpt-6.1-sol` 在本次调用中被提供方拒绝；原生模型目录默认项 `gpt-6-astra` 成功。桥接服务可独立选择模型。

## 最终交付状态

- 已安装 `dsh-codex-collab@dsh-local` 0.1.0，目录：`/Users/yang/.codex/plugins/cache/dsh-local/dsh-codex-collab/0.1.0`。
- CLI 安装包 SHA-256：`36b7faaddb91918585a6fc74cb36379d21b4b755e4923ea6ec53fa2b73d4cd70`。
- 安装前原始配置备份：`/Users/yang/.codex/backups/dsh-codex-collab-2026-10-06T18-07-10-336Z-41bc3f87/`。
- 最终安装与文件校验记录：`/Users/yang/.codex/backups/dsh-codex-collab-2026-10-06T18-14-41-958Z-d6328908/install-record.json`。
- 主配置只增加本插件及其本地插件市场；原模型及其他配置值保持一致。验证见 `artifacts/config-preservation.json`。
- 中继已注册并在线，独立数据目录为 `/Users/yang/.local/share/dsh-codex-collab`；未向线上协作任务发布测试内容。
- Android 真机：当前没有连接设备，尚未进行用户手机上的扫码和交互验证。
- 子会话归属、早到通知和用量隔离以确定性协议测试验证；没有为此启动实际模型子代理。
- 未验证 Linux 真机；Windows 私有凭据存储未实现。未安装系统自启动项，未发布插件或部署中继服务。

完整包与源文件的校验清单位于 `dist/manifest.json` 和 `artifacts/final-verification.json`。`artifacts/` 是本机验证输出，不随插件发布，可能包含本机路径和会话记录。
