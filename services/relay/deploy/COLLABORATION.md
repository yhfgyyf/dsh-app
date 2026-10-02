# DSH 协作空间

协作服务在中继保存任务、消息、方案、订阅和收件箱，实际求解在用户选择的本机 DSH 运行。插件默认关闭，阅读、同步和推送不会调用模型。任务发布者负责采纳方案；各节点可同时参与。

## 启用与使用

1. 部署兼容的私有中继和新增协作服务，使同一个 HTTPS 地址同时转发 `/v1/*`、`/health` 和 `/collab/v1/*`。专网和互联网入口必须指向同一套服务、同一个数据库；沿用已绑定设备的入口列表、证书和 CA。
2. 在 DSH 的远程连接设置注册中继。协作不要求开启远程控制。在插件管理中启用 `dsh-p2p-collab`，侧栏出现“协作空间”。
3. 每个安装首次启用时生成 UUID 和随机昵称，可在协作设置修改昵称。`DSH_DESKTOP_STATE_HOME/collaboration/profile.json` 保存身份、草稿、游标和本机运行记录；升级、禁用后重新启用会保留。更换中继或丢失此文件时不能静默继承旧身份，需要保留旧备份并单独处理身份迁移。
4. 点击任务先读详情，再自行选择关注、回复、生成 DSH 回复或本机求解。新会话使用独立目录，只带入所选任务、验收条件和用户补充要求。需要的附件由用户下载后加入会话；不会自动上传会话历史或本地文件。
5. 求解后导入草稿，检查正文、验证结果、附件和用量，点击确认发布。方案可发布修订版本，旧方案保留。任务编辑使用版本冲突检查，修改历史可查看。发布者采纳后标为已解决，也可重新开放。

“独立目录”不是额外的文件系统沙箱，求解仍受现有 DSH 工具权限和审批控制。每次运行固定时间和 Token 阈值，监控每 3 秒检查；Token 阈值按已结算调用累计，进行中的调用可能超出。未知用量显示未知，不按零计算。报告合计包括所属子任务和重试，排除继承历史；推理 Token 属于输出子集，不重复相加。数据来源是客户端运行记录，并非中继独立核验的账单。

桌面协作采用普通 HTTP 请求收发任务和消息，进入页面、点击“刷新消息”或页面可见时每分钟获取更新，不维持在线状态连接。网络错误只影响本次操作，草稿保留，可再次提交；相同操作编号不会重复发布。这与手机远程控制的 WebSocket 长连接不同，远程控制的心跳、重连和会话通道保持原样。已有协作服务和手机通知接口继续兼容，无需为这次桌面修复重新部署中继。

预算支持亿级 Token 和多天任务；Token 或分钟数填 `0` 表示不限制对应项，两项均为 `0` 时需要用户主动停止。已有配置不会被覆盖。新安装的默认值为 100 万 Token、480 分钟。图片与附件每个最多 8 MiB、每次最多 8 个；超限文件请在正文粘贴可访问的下载链接。PNG、JPEG、GIF、WebP 可点击预览，预览和下载都会验证文件大小及 SHA-256。

## Docker 配置

`compose.collaboration.yml` 是现有 `compose.yml` 的附加文件。使用原 Compose project name，保留原 relay volume、DB_PATH、`.env`、TLS 配置和证书。不要执行 `down -v`。已有 systemd 部署不能直接套用 Compose，以免创建第二套注册数据库；应先制定保留原服务和数据库的具体部署步骤。

私有中继与协作容器共享一个至少 32 字节的随机 `COLLAB_AUTH_SECRET`。只在首次部署时生成，将其加入受限权限的 `.env`，不得提交到版本库。下面命令只写文件，不打印 secret；执行前先确认 `.env` 中没有同名变量：

```sh
node -e 'process.stdout.write("\nCOLLAB_AUTH_SECRET=" + require("node:crypto").randomBytes(32).toString("hex") + "\n")' >> .env
chmod 600 .env
docker compose -f compose.yml -f compose.collaboration.yml build
docker compose -f compose.yml -f compose.collaboration.yml up -d relay collaboration
```

把 `nginx.collaboration.conf.example` 中的 location 加到原有各个 TLS server 内，先执行 `nginx -t` 再按现有方式 reload。保持原 `/`、WebSocket 和远程控制路由。协作端口默认只映射到宿主机回环 `127.0.0.1:8788`；外部通过原 TLS 入口访问。

协作 SQLite 使用 WAL、外键和独立 named volume。附件以 BLOB 存储在同一数据库，便于一致备份。每个附件最多 8 MiB，每次最多 8 个；节点附件配额 256 MiB，总附件配额 1 GiB。普通任务关闭不删除历史。第一版为单实例服务，不支持多副本同时写同一个文件。

短期协作 grant 不暴露桌面长期注册凭据，手机复用已有绑定。所有读取、下载和写入均先向私有中继验证设备/绑定仍有效；手机只读任务，可更新收件箱已读状态。此协作空间是同一中继认证成员共享空间，内容对成员及中继管理员可见，与远程控制的端到端加密通道分开。

## 不依赖 Google Play 的手机消息

Android 自动通过已绑定中继读取协作消息，优先专网、失败后尝试授权的互联网入口，切换前核对 relay ID。连接不经过电脑，所以电脑离线仍可查看任务和接收其他节点消息。通知只包含通用提示和任务定位，点击后重新鉴权读取详情；可在手机设置打开“协作任务与消息”，也可下载并校验附件。

手机设置中的“协作消息后台接收”使用 Android `remoteMessaging` 前台服务和常驻通知，无 FCM、Google Play 或第三方云推送依赖。不开启时，应用在前台同步；开启后在后台保持中继 WebSocket。使用平台和用户安装的可信 CA，沿用原手机证书配置。

这不是系统级免休眠推送。断网、系统深度休眠、厂商后台限制或强制停止可能延迟接收；重连后从中继持久化收件箱补齐，按本地接收位置去重，点击任务只清除对应任务的未读项。需在目标专网/公网手机验证锁屏、网络切换、通知权限和强制停止后的恢复。

参考：[Android 前台服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types#remote-messaging)、[Doze 网络限制](https://developer.android.com/training/monitoring-device-state/doze-standby)。

## 备份、管理与回退

每次升级前先保留原镜像、Compose、私有中继数据库及环境文件；新增协作库可在线一致备份。`backup` 校验 SQLite 完整性和外键，目标必须是新的绝对路径，附件包含在备份内：

```sh
docker compose -f compose.yml -f compose.collaboration.yml exec collaboration node dist/collab-admin.js backup /data/backups/collaboration-before-upgrade.sqlite
docker compose -f compose.yml -f compose.collaboration.yml cp collaboration:/data/backups/collaboration-before-upgrade.sqlite ./collaboration-before-upgrade.sqlite
```

复制到独立存储，记录 SHA-256 并限制读取权限。不要单独复制运行中的 `.sqlite` 文件而忽略 WAL。恢复时先停协作服务，保留当前库及 WAL/SHM，再替换成已校验的副本并检查所有权；不要覆盖私有中继的注册库。日常代码回退只切换旧镜像，保留当前数据。

管理员可对明确 ID 暂停节点或隐藏任务，内容保留且有管理日志；反向命令可恢复。命令需设置 `COLLAB_DB_PATH` 指向已有库，数据库路径错误时拒绝新建。示例动作：

```sh
node dist/collab-admin.js hide-task TASK_ID 'operator reason'
node dist/collab-admin.js show-task TASK_ID 'restored after review'
node dist/collab-admin.js ban-peer PEER_ID 'operator reason'
node dist/collab-admin.js unban-peer PEER_ID 'restored after review'
```

新读取立即应用限制，已打开的 WebSocket 最迟在下一次 30 秒心跳鉴权时关闭。回退协作功能可先关闭桌面插件、停止协作容器、撤下新增 location，保留 volume；私有中继在无协作 secret 时仍提供原远程功能。
