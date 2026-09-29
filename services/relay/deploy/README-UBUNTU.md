# DSH 私有中继：Ubuntu 测试部署

此包服务于 DSH Desktop 0.1.29 与 DSH Remote Android，协议为 `dsh-desktop-remote-v1`。它包含独立中继源码、锁定依赖、编译结果和部署模板，不包含账号、数据库、密码或桌面会话。部署机需要能访问 npm 下载依赖。

## 1. 安装并验证

适用 Ubuntu x86_64 / arm64，预先安装 Node.js 22 LTS（`node --version` 应输出 `v22.x`）。使用组织批准的 Node 安装方式，不要使用 Ubuntu 旧版默认 Node。SQLite 依赖有原生组件，必须在 Ubuntu 上安装依赖，不能复制 Mac 的 `node_modules`。

在解压后的目录执行：

```sh
sudo apt-get update
sudo apt-get install -y build-essential python3 nginx
npm ci --no-audit --no-fund
npm run build
npm test
```

测试只启动回环服务和内存数据库，检查注册、配对、权限以及未批准/离线访问拒绝。完整手机/桌面加密和会话测试已在主项目进行，`PACKAGE-MANIFEST.json` 记录来源；此包未在你的 Ubuntu 服务器运行过。

## 2. 安装到固定目录

以下按首次安装配置；已有同名服务或目录时先备份并比较配置。`npm ci` 和构建应以普通用户完成。

```sh
sudo useradd --system --user-group --home-dir /var/lib/dsh-relay --shell /usr/sbin/nologin dsh-relay
sudo install -d -m 755 /opt/dsh-relay
sudo cp -a . /opt/dsh-relay/
sudo chown -R root:root /opt/dsh-relay
sudo install -d -o dsh-relay -g dsh-relay -m 700 /var/lib/dsh-relay
sudo install -m 640 -o root -g dsh-relay deploy/relay.env.example /etc/dsh-relay.env
sudo install -m 644 deploy/dsh-relay.service /etc/systemd/system/dsh-relay.service
command -v node
```

把服务文件的 `ExecStart=/usr/bin/node` 改成实际 Node 22 的绝对路径。Node 必须位于服务账号可读、可执行的系统目录；模板的 `ProtectHome=true` 不允许使用其他用户家目录内的 nvm 路径。

编辑 `/etc/dsh-relay.env`：

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
DB_PATH=/var/lib/dsh-relay/private-relay.sqlite
PUBLIC_RELAY_URL=https://relay.example.com:8443
```

`HOST`/`PORT` 是内部监听；`PUBLIC_RELAY_URL` 是手机和电脑使用的公网或专网 HTTPS 入口。IP、域名和外部端口均可改，内部与外部端口无需相同。外部入口必须提供匹配地址、客户端信任的证书。

Nginx 与中继同机时保持 `127.0.0.1:8787`。若反向代理位于另一台服务器，改为中继机器的内网 IP，并将代理的 `proxy_pass` 改成该内部地址，内部端口只向代理开放。

## 3. HTTPS 入口

准备自己的证书，将 `deploy/nginx.conf.example` 的域名、端口和证书路径替换后安装到 Nginx。示例监听 8443，并支持 WebSocket。若网关还做端口映射，`PUBLIC_RELAY_URL` 必须填写客户端实际访问的外部端口。

```sh
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/dsh-relay
# 先编辑 /etc/nginx/sites-available/dsh-relay 的地址和证书路径。
sudo ln -s /etc/nginx/sites-available/dsh-relay /etc/nginx/sites-enabled/dsh-relay
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-relay
curl --fail http://127.0.0.1:8787/health
curl --fail https://relay.example.com:8443/health
```

`/health` 应返回 `ok: true` 和上述协议名。公网/专网路由、防火墙及网关映射需允许访问所选 HTTPS 端口。无需开放电脑端口。

## 4. 创建账号和一次性设备注册码

在 Bash 中执行，把 `/usr/bin/node` 改成服务使用的 Node 路径。账号是管理员手动创建的标识，不会发送验证邮件。密码至少 12 位；注册码有效 10 分钟。

```sh
sudo -v
read -rs -p '新账号密码（至少 12 位）: ' remote_password
printf '\n'
printf '%s' "$remote_password" | sudo -u dsh-relay /usr/bin/node --env-file=/etc/dsh-relay.env /opt/dsh-relay/dist/private-admin.js account operator@example.com
unset remote_password
sudo -u dsh-relay /usr/bin/node --env-file=/etc/dsh-relay.env /opt/dsh-relay/dist/private-admin.js registration operator@example.com
```

将最后一条命令输出的注册码填入桌面 App。此包没有公开自助注册接口，也没有上游公共账号服务。

## 5. Windows 与 Android 测试

1. 安装本次 Windows 0.1.29 与 Android 调试 APK。Android 包名为 `io.github.yhfgyyf.dshremote.debug`，需要 Android 8.0 及以上。
2. Windows 打开“设置 → 通用设置 → 手机远程控制 → 管理连接”，填与 `PUBLIC_RELAY_URL` 相同的 HTTPS 地址，保存，输入注册码并注册电脑。
3. 开启远程控制，点击“配对手机”；二维码有效 120 秒。
4. Android 扫码，核对地址和电脑名，使用同一账号密码登录；在电脑端允许“仅查看”或“会话控制”。
5. 在手机创建会话、发送消息，确认桌面能看到同一会话；再从桌面改名，检查手机刷新后的名称。
6. 桌面撤销手机，确认手机不能继续连接。需要关窗口后继续运行时，显式勾选后台运行选项；退出 App 或关机后不可访问。

当前二维码使用桌面填写的中继地址。不要在桌面填写只能在内网访问的 IP，却期待二维码自动切换公网 IP。内外网可使用同一域名和端口配合分离 DNS；尚不支持独立的桌面内网地址与手机公网地址字段。

Android 调试包可安装，但不作为应用商店正式发行包。扫码相机、Android Keystore 和你的实际网络仍需实机验收。远程控制权限允许在该电脑上通过 DSH 执行任务。

## 6. 排查与停止

```sh
sudo systemctl status dsh-relay
sudo journalctl -u dsh-relay -n 100 --no-pager
sudo ss -lntp | rg '8787|8443'
sudo systemctl stop dsh-relay
```

无 `rg` 时可改用 `grep -E`。桌面支持“导出诊断”，内容不含配对密钥或账号。数据库位于 `DB_PATH`；备份时停服务后复制数据库及残留 WAL/SHM 文件，恢复时保留服务账号权限。不要删除数据目录来排查连接问题。

中继只保存账号、设备和绑定元数据；会话内容通过手机与桌面之间的加密隧道传输，仍保存在电脑上的 DSH。当前 PSK 加密协议不提供前向保密。
