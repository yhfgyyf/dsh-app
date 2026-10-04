# DSH 协作空间

协作服务在中继保存任务、消息、方案、订阅和收件箱，实际求解在用户选择的本机 DSH 运行。插件默认关闭，阅读、同步和推送不会调用模型。任务发布者负责采纳方案；各节点可同时参与。

## 启用与使用

1. 部署兼容的私有中继和新增协作服务，使同一个 HTTPS 地址同时转发 `/v1/*`、`/health` 和 `/collab/v1/*`。专网和互联网入口必须指向同一套服务、同一个数据库；沿用已绑定设备的入口列表、证书和 CA。
2. 在 DSH 的远程连接设置注册中继。协作不要求开启远程控制。在插件管理中启用 `dsh-p2p-collab`，侧栏出现“协作空间”。
3. 每个安装首次启用时生成 UUID 和随机昵称，可在协作设置修改昵称。`DSH_DESKTOP_STATE_HOME/collaboration/profile.json` 保存身份、草稿、游标和本机运行记录；升级、禁用后重新启用会保留。插件 0.1.6 另将恢复凭据保存在同目录的 `recovery.json`，权限为 0600；备份时一同保存，勿贴入诊断报告或公开分享。更换中继或丢失身份文件时不能静默继承旧身份。
4. 点击任务先读详情，再自行选择关注、回复、生成 DSH 回复或本机求解。新会话使用独立目录，只带入所选任务、验收条件和用户补充要求。运行会自动下载任务和讨论中的附件并校验大小与 SHA-256，优先读取待评估贡献，单轮最多 8 个文件、64 MiB；保留来源回复和本地路径，超限项明确标为未下载、未验证。下载和哈希校验不等于候选通过验证；不会自动上传会话历史或无关本地文件。
5. 求解后导入草稿，检查正文、验证结果、附件和用量，点击确认发布。方案可发布修订版本，旧方案保留。任务编辑使用版本冲突检查，修改历史可查看。发布者采纳后标为已解决，也可重新开放。

“独立目录”不是额外的文件系统沙箱，求解仍受现有 DSH 工具权限和审批控制。每次运行固定时间和 Token 阈值，监控每 3 秒检查；Token 阈值按已结算调用累计，进行中的调用可能超出。未知用量显示未知，不按零计算。报告合计包括所属子任务和重试，排除继承历史；推理 Token 属于输出子集，不重复相加。数据来源是客户端运行记录，并非中继独立核验的账单。

桌面协作采用普通 HTTP 请求收发任务和消息，进入页面、点击“刷新消息”或页面可见时每分钟获取更新，不维持在线状态连接。网络错误只影响本次操作，草稿保留，可再次提交；相同操作编号不会重复发布。这与手机远程控制的 WebSocket 长连接不同，远程控制的心跳、重连和会话通道保持原样。

## 本次认证与协作流程升级顺序

先升级私有中继，再升级协作服务，最后更新 `dsh-p2p-collab` 插件至 0.1.6。两端服务均需本轮代码，才能在设备重新注册后验证原设备已注销并恢复协作身份。新插件还依赖候选索引、按消息定位讨论页、精确标记事件已读和探索状态筛选，旧协作服务不能完整提供这些接口。协议名仍为 `dsh-collab-v1`，只检查 `/health` 不足以确认升级成功；需要核对运行代码和包清单，并验证新增接口。新服务保留旧客户端的讨论分页和 `through` 批量已读接口；“我参与的”只列真实探索，候选数量只计未被替代的方案。

升级前确认实际服务名、启动入口、Node 路径及协作数据库位置，保留现有代码或镜像，并备份协作数据库、私有中继注册数据库和相关服务配置。环境文件备份限制访问，不打印或重新生成已有 secret，不替换 TLS 证书、入口、端口或数据库路径。本轮为 `collab_peers` 增加可空的 `recoveryHash` 列，旧记录保持原值和历史。先在数据库备份副本上运行新代码及旧代码回退检查；更早版本还须验证其已有迁移。

协作服务与手机远程控制的私有中继是两个进程、两份数据库。已支持协作 grant 的旧私有中继仍可提供普通协作认证，但没有新增的旧设备注销证明，不能完成自动恢复；须更新两个服务。保持远程控制服务的配置、共享 secret 和代理路由。`deploy/upgrade.mjs` 仅管理 `dsh-relay.service` 的私有中继升级，不会备份、切换或验收协作服务，不能将其 `UPGRADE_OK` 当作协作升级完成。

在独立发布目录构建并测试后，按上述顺序短暂停止对应服务、切换到新代码并启动；确认进程、数据库、鉴权和新增接口正常后再更新客户端插件。失败时切回已验证的原代码或镜像并保留当前数据库，不用升级前快照覆盖升级后的消息；旧服务期间身份自动恢复不可用。不要直接将 Docker 模板套到现有 systemd 部署，或启动第二个写入同一协作库的实例。

### 新旧版本认证兼容

| 客户端与服务 | 普通加入和读取 | 注销后恢复原协作身份 |
| --- | --- | --- |
| 旧插件 + 新服务 | 保留原认证协议 | 没有恢复凭据，需管理员核对修复 |
| 0.1.6 插件 + 支持 grant 的旧协作服务 | 保留普通协作认证 | 未支持恢复凭据登记；需升级两端服务 |
| 0.1.6 插件 + 两端新服务 | 正常 | 曾由原合法设备登记凭据，且旧注册已注销时可自动恢复 |
| 任意插件 + 缺少协作 grant 的早期私有中继 | 需先升级私有中继并配置协作服务 | 不可用 |

服务端只保存恢复凭据的摘要。自动恢复保留协作节点 ID 和所有引用该 ID 的历史，条件包括凭据匹配、节点未停用、旧注册已注销、新注册未绑定其他协作节点。昵称和设备名称不能作为自动继承身份的证明。原设备仍能正常认证但本机恢复文件丢失或不匹配时，普通加入保持可用，服务端不会覆盖已登记的摘要；后续恢复需找回原文件或由管理员处理。

诊断中的 `recovery.ready` 只表示服务端已登记本机凭据；如果仅升级协作服务，旧私有中继仍无法提供注销证明，实际恢复会返回 `identity_recovery_unsupported`。须核对两端运行代码，不能仅凭 `ready` 判断整套部署已升级。

对于升级前已经重新注册、协作身份仍绑定旧设备的记录，客户端无法事后证明自己是原设备，必须使用下述管理员修复。不要删除协作库或重建节点来绕过冲突。

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

### 修复升级前遗留的设备绑定

先从原客户端身份备份、私有中继注册记录与管理员核对中取得三个确切 ID：原协作节点、预期旧设备、新设备。设备名仅供额外核对，不能证明归属。使用具有两份数据库读写权限的管理员账号；参数路径必须指向已有绝对路径。下面的诊断和预检不会修改数据，也不会给旧数据库补列：

```sh
export DB_PATH=/var/lib/dsh-relay/private-relay.sqlite
export COLLAB_DB_PATH=/var/lib/dsh-relay/collaboration/collaboration.sqlite
node dist/collab-admin.js diagnose-identity PEER_ID OLD_DEVICE_ID NEW_DEVICE_ID
node dist/collab-admin.js repair-identity PEER_ID OLD_DEVICE_ID NEW_DEVICE_ID --dry-run
```

结果为 `ready` 才能应用。`blocked` 会列出拒绝原因并以状态码 1 退出。必须满足原节点未停用、当前绑定仍为预期旧设备、旧注册不存在、新注册存在且未占用其他节点、两库完整性及外键校验通过。可加 `--expected-device-name '192.168.2.113'`，要求私有中继中该名称唯一且对应新设备；没有提供时仍强制校验三个 ID。

确认身份后，选择一个尚不存在的备份目录，其父目录须已创建：

```sh
node dist/collab-admin.js repair-identity PEER_ID OLD_DEVICE_ID NEW_DEVICE_ID \
  --apply --backup-dir /var/backups/dsh-relay/identity-repair-UNIQUE_TIMESTAMP \
  --reason '管理员已核对原节点与新设备归属'
```

命令按私有库、协作库顺序取得写锁，在保持锁定期间分别创建包含 WAL 已提交数据的 SQLite 备份，校验完整性、外键和 0600 权限，写入带摘要的 `intent.json` 后才执行单行条件更新。协作节点 ID、昵称、恢复摘要、任务、回复、附件和其他历史保持原样；修复与 `collab_admin_log` 审计在同一事务提交。`intent.json` 是提交前意图，不能单凭它认定修复已完成。

成功返回 `applied`；对已提交且审计中三 ID 相符的修复重跑返回 `already-applied`，不重复写入备份。失败时未提交修改回滚，可能留下部分备份目录供核查；重试未提交操作须使用新目录。修复后让新客户端重新同步，再核对原节点与历史；若已有恢复摘要但本机丢失对应文件，此命令不会清空或覆盖摘要，后续自动恢复仍需找回原恢复文件。

管理员可对明确 ID 暂停节点或隐藏任务，内容保留且有管理日志；反向命令可恢复。命令需设置 `COLLAB_DB_PATH` 指向已有库，数据库路径错误时拒绝新建。示例动作：

```sh
node dist/collab-admin.js hide-task TASK_ID 'operator reason'
node dist/collab-admin.js show-task TASK_ID 'restored after review'
node dist/collab-admin.js ban-peer PEER_ID 'operator reason'
node dist/collab-admin.js unban-peer PEER_ID 'restored after review'
```

新读取立即应用限制，已打开的 WebSocket 最迟在下一次 30 秒心跳鉴权时关闭。回退协作功能可先关闭桌面插件、停止协作容器、撤下新增 location，保留 volume；私有中继在无协作 secret 时仍提供原远程功能。
