# DSH 私有中继：保留数据的 Ubuntu 升级

本包包含多入口映射功能：桌面可以连接服务器内网 IP，手机连接 APN/NAT IP 或互联网入口，手机按局域网 → 专网 → 互联网选择。所有入口必须到同一个中继进程。旧的局域网和单中继方式继续支持。

适用现有部署：`dsh-relay.service`、程序 `/opt/dsh-relay`、环境配置 `/etc/dsh-relay.env`，Ubuntu x86_64/arm64、Node 22。本说明针对已有注册和证书的升级，不需要重新创建账号、注册码、CA 或服务用户。

## 可选：桌面自动取得 CA，无需升级中继服务

Desktop 0.1.34 支持只输入地址和带 CA 指纹的注册码，自动取得并保存该中继的根 CA。服务端 TLS 证书链须包含该根 CA；现有服务器证书仍须匹配客户端填写的 IP/域名。客户端核对指纹后才发送注册码，HTTPS/WSS 继续校验证书链、有效期和地址。桌面不改系统信任库，也不需要 sudo。

如果只是启用这个功能，可直接使用本包独立的 `dist/registration-code.js`（也可复制并改名为 `.mjs`）。它只使用 Node 内置模块，不需要安装依赖、改数据库格式、替换正在运行的服务或重启。沿用原管理命令的账号与 `DB_PATH`，把一次性注册码通过标准输入传给它：

```sh
node /opt/dsh-relay/dist/private-admin.js registration operator@example.com | node /path/to/registration-code.mjs /path/to/existing-root-ca.pem
```

将输出的完整 `dshca1_...` 注册码交给桌面用户即可，仍为一次有效、10 分钟过期；根证书无需复制给用户。证书路径应指向已有的根 CA，不能填服务器叶证书或私钥。普通旧注册码仍需事先信任 CA，不能从未知连接自动确认 CA 身份。

若已采用本包新版管理工具，也可以直接执行：

```sh
node dist/private-admin.js registration operator@example.com --ca-file /path/to/existing-root-ca.pem
```

只为生成这种注册码，不必执行下方的完整服务升级。已有注册和手机绑定保持原状；局域网配对不会自动解除中继注册，解除注册需在桌面明确点击并确认。

## 保留范围与回退行为

- 原 `/opt/dsh-relay`、原 systemd 服务文件、原 `/etc/dsh-relay.env` 保留。
- 不安装或重载 Nginx/Caddy，不复制证书模板，不修改 CA、证书、私钥或系统信任库。即使证书在原程序目录内，也不会被替换。
- 使用运行中服务的实际绝对 `DB_PATH`；路径不存在、与环境配置不一致或程序布局不符时，升级前直接拒绝，不创建空数据库。
- 新代码和 Ubuntu 上安装的依赖放在 `/opt/dsh-relay-releases/` 的独立目录，仅通过 `90-dsh-relay-release.conf` 切换 `ExecStart`。工作目录、用户、监听地址、端口和环境文件沿用原服务。
- 切换前短暂停服务，备份 SQLite 与现存 WAL/SHM 到 `/var/backups/dsh-relay/`，再用备份副本验证新 schema 保留已有账号、注册码、设备、邀请和绑定。此次迁移只新增中继标识元数据，旧代码仍可读取数据库。
- 新进程、数据库标识或 `/health` 检查失败时，自动恢复原启动入口并检查旧服务。成功升级后仍可以手动回退。
- **回退只切换代码，不自动用旧快照覆盖当前数据库。** 升级后新增的注册、绑定及解绑状态因此不会被回退抹掉。数据库备份用于灾难恢复，不能直接当作日常回退步骤覆盖。

升级期间不要同时运行管理命令、手工改配置或启动第二个中继实例。终止信号会进入回退；断电或强制 `kill -9` 后，使用已经写入磁盘的回退记录恢复。

## 1. 上传和准备

把 tar 包与同目录的 `SHA256SUMS` 上传到服务器。先以普通用户执行，旧服务可继续运行：

```sh
sha256sum -c SHA256SUMS
tar -xzf DSH-Relay-{{RELAY_VERSION}}-source.tar.gz
cd dsh-relay-{{RELAY_VERSION}}
node --version
npm ci --no-audit --no-fund
npm run build
npm test
```

Node 应为 `v22.x`。`better-sqlite3` 有原生组件，必须在目标 Ubuntu 安装依赖；不要复制 Mac 的 `node_modules`。部署机需要访问 npm，或使用你现有的内部 npm 镜像。若需要从源码编译原生组件，沿用服务器已有的 Python 3 / C++ 构建工具。

包内测试使用临时目录、回环端口和独立数据库，不接触 `/etc`、`/opt` 或正式数据库。升级测试使用旧版 0.1.30 的真实中继代码和模拟 systemd 控制层，覆盖升级、故意启动/健康失败、回退和注册保留；它不等于服务器实际 systemd 验收。

## 2. 可选：增加手机入口

先完成代码升级、继续沿用原地址也可以。若本次就需要 APN/NAT 多入口，只在现有 `/etc/dsh-relay.env` 中增加以下变量，保留原有 `DB_PATH`、`HOST`、`PORT`、`PUBLIC_RELAY_URL` 和其他配置：

```ini
RELAY_CLIENT_ENDPOINTS='[{"origin":"https://10.80.0.9:8443","network":"private"},{"origin":"https://203.0.113.9:9443","network":"public"}]'
```

上面的 IP 都是示例，必须替换；没有互联网入口时只保留 private 项。最多 6 项，不写 URL 路径、查询参数或用户名密码。改动这一个变量后，继续执行下节升级；不要先重启旧服务或重装模板文件。

各入口须转发 `/health`、`/v1/*` 和 WebSocket Upgrade。使用 IP 访问时，现有 TLS 证书须包含该入口的 IP SAN，手机和电脑须信任其签发 CA。NAT 不会改写证书；本包不会替你重签或覆盖证书，也不会创建 APN 路由或防火墙规则。

## 3. 检查与升级

以下假定服务的 Node 22 为 `/usr/bin/node`；如实际路径不同，使用原服务 `ExecStart` 中的 Node 绝对路径。不要改用另一套 Node 运行升级脚本。

```sh
systemctl show dsh-relay.service -p ExecStart --value
sudo /usr/bin/node deploy/upgrade.mjs check
sudo /usr/bin/node deploy/upgrade.mjs apply
```

`check` 不停服务、不切换代码。它校验包清单、Node/原生模块、现有运行进程、配置和健康接口。`apply` 会再次检查，先在新目录准备代码，再停服务备份和切换。

开始停服务之前会打印：

- `Backup and recovery journal: ...`：本次备份目录。
- `Rollback: sudo ...`：即使原解压目录被移走仍可执行的完整回退命令。

请保存这两行。成功时最后输出 `UPGRADE_OK`；失败但已恢复旧服务时输出 `ROLLBACK_OK`，升级命令仍返回非零退出码。若出现 `AUTOMATIC_ROLLBACK_FAILED`，保留所有目录，根据备份记录和服务日志处理，不要清空数据库或重新注册。

```sh
sudo systemctl status dsh-relay.service --no-pager
sudo journalctl -u dsh-relay.service -n 80 --no-pager
```

然后用原来的 HTTPS 地址和既有 CA 检查 `/health`，并从已注册桌面、已绑定手机验证连接。脚本自动验证原监听地址的后端 HTTP 健康接口；外部 TLS、NAT 和 APN 需要在实际网络验收。

如果只升级服务器代码，原绑定无需重注册。要使用新增多个入口，需要桌面和 Android 同时包含此功能，再刷新二维码绑定；旧手机已有绑定不会自动获得后来添加的入口列表。

## 4. 手动回退

优先执行升级时打印的完整 `Rollback:` 命令。也可以从本包目录执行，把下面最后一项替换成**本次**打印的目录：

```sh
sudo /usr/bin/node deploy/upgrade.mjs rollback /var/backups/dsh-relay/本次备份目录
```

回退会短暂停服务、恢复原启动入口、重新启动并检查旧代码。原环境配置、证书和当前数据库保持原状。如果后来又升级过一次，应先回退最近一次；脚本会拒绝用旧记录覆盖更新的部署。

回到不支持多入口的旧服务后，多入口功能暂停；原单中继/LAN 功能仍按原版本工作。新产生的注册/绑定记录保留，之后重新升级即可继续使用。环境配置不会自动被旧备份覆盖；若你还需要撤回新增的入口配置，只修改对应变量并与备份对照。

备份目录权限为 700，包含：原环境配置、原 systemd 配置、原入口信息、数据库与 WAL/SHM、校验哈希、迁移副本和回退状态。它包含认证数据，应保留在服务器受限目录。不要删除旧程序目录、releases 或备份目录，直到完成验证和保留期。

## 5. 验收清单

1. 原 HTTPS 地址仍使用既有证书，客户端无需重新安装 CA。
2. 原账号可以继续使用；已注册桌面能上线，原绑定手机可访问。
3. 使用多入口时，桌面内网地址和手机 APN/NAT 地址访问同一实例；LAN 优先，专网失败后可使用配置的互联网入口。
4. 在维护窗口需要回退时，执行打印的回退命令；检查旧服务健康以及原注册仍在。

参考：[systemd 的服务启动与 ExecStart 配置](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)、[SQLite WAL 备份边界](https://sqlite.org/wal.html#the_wal_file)。WAL 属于数据库持久状态，不能在备份中遗漏或单独随意删除。
