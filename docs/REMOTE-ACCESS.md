# DSH Remote 源码与本地验证

此功能使用 Desktop 0.1.28 / DSH 0.2.0-rc.1 的同一个 Host。桌面主动连接中继，Android 扫码后访问已有会话。远程默认关闭，不需要开放电脑端口。

## 代码位置

- `src/main/remote-access*`：设置、加密凭据、配对确认与撤销。
- `src/runtime/remote/`：Host 桥接、接口权限、加密协议。
- `src/renderer/remote-access.tsx`：设置 → 通用设置 → 手机远程控制。
- `services/relay/`：自建中继。此分支默认入口为 `private-server`，原上游入口仅保留作参考。
- `mobile/android/`：原生 Kotlin Android 客户端；包名 `io.github.yhfgyyf.dshremote`，与上游分开安装。

上游来源及固定提交见 [REMOTE-SOURCES.json](../REMOTE-SOURCES.json)。Android 复用原有会话、历史、流、提问与审批界面。中央中继使用 `dsh-desktop-remote-v1`；它与 Android 上游原有局域网 `dsh-relay-pair` 不是同一协议，扫码器会区分两者。

## 中继准备

服务器建议使用 Node 22 LTS、Linux x86_64/arm64。桌面龙芯支持不代表服务器的 SQLite 原生依赖已经适配龙芯。

```sh
cd services/relay
npm ci
npm run build
export DB_PATH=/srv/dsh-relay/private-relay.sqlite
export PUBLIC_RELAY_URL=https://relay.example.com
export HOST=127.0.0.1
export PORT=8787
npm start
```

在前置代理配置 TLS 和 WebSocket；示例 [Caddyfile.private](../services/relay/Caddyfile.private)。公网和专网应使用同一个域名和后端实例，可使用内外分离 DNS。不要关闭证书校验。中继不需要访问桌面的局域网 IP。

管理员在中继机器执行，密码通过标准输入送入，避免写入命令历史：

```sh
read -rs -p '新账号密码（至少 12 位）: ' remote_password
printf '%s' "$remote_password" | node dist/private-admin.js account operator@example.com
unset remote_password
node dist/private-admin.js registration operator@example.com
```

第二条管理命令输出一次性注册码，10 分钟有效。数据库和目录仅供服务账号读写，备份数据库及其 WAL 状态；不要把它们提交到仓库。没有开放账号注册的 HTTP 接口。修改中继地址前，先在桌面点击“注销电脑”并确认，再重新注册；已有凭据不能直接发送到另一地址。

## 配对与使用

1. 桌面打开“设置 → 通用设置 → 手机远程控制 → 管理连接”，填写 HTTPS 地址和电脑名称，保存。
2. 填写管理员生成的注册码，注册电脑，然后开启远程开关。
3. 点击“配对手机”；二维码有效期 120 秒。
4. Android 打开配对页面扫码，核对中继和电脑名称，输入管理员邀请的账号密码。
5. 桌面会显示申请者，选择“允许仅查看”或“允许会话控制”。手机随后连接原来的 Host。
6. 在桌面的已配对设备列表撤销手机。撤销先在本机生效，中继离线时稍后同步。

管理面板显示已配对手机的在线状态和最近连接时间。“导出诊断”保存中继连接状态、设备数量与平台版本，不包含二维码、绑定密钥、设备令牌或手机账号。

二维码包含该绑定的加密初始化材料，应只交给自己的手机。控制权限允许手机通过 DSH 执行任务，不是给不可信用户使用的操作系统沙箱。查看权限在 Host 桥接层拦截写接口及控制流，也不能直接浏览任意工作区文件；它可读取会话及会话附件。远程接口不开放凭据管理、插件安装、任意代理 URL 和原生终端接口。

默认关闭窗口沿用原有行为。需要后台在线时勾选“关闭窗口后继续运行”，窗口隐藏到托盘；显式退出仍停止 Host。没有系统托盘时保留窗口。麒麟系统需要可用的 Secret Service；检测到 `basic_text` 会拒绝持久保存，可明确选择“仅本次运行”，重启后重新注册配对。

## 构建和检查

桌面：

```sh
npm run typecheck
node --test tests/remote-access.test.ts tests/remote-interactions.test.ts
npm run build
npm run test:remote-ui
cd services/relay && npm ci && npm run build && npm test
cd ../.. && node scripts/test-mobile-remote.mjs
```

最后一个脚本只使用 `.test-data/mobile-remote-*` 的隔离目录、回环中继和 App 自己的 Host，不接触日常配置，也不调用真实模型。

Android 需要 JDK 17、Android SDK 35 和 Gradle Wrapper：

```sh
cd mobile/android
./gradlew :core:test :app:assembleDebug --no-daemon
```

调试 APK 在 `mobile/android/app/build/outputs/apk/debug/`；发布构建应配置自己的签名，不使用上游的自动更新 APK。Android Keystore 保存每台电脑对应的手机凭据和加密密钥。

## 协议和边界

- 注册、登录、邀请、确认使用 HTTPS。桌面 `/v1/device` 与手机 `/v1/tunnel` 主动 WSS 连接；凭据在第一帧认证，不写进 URL。访问票据只可使用一次，30 秒有效。
- 邀请认领后立即作废；桌面确认前不能获取访问票据。每部手机有独立绑定、令牌与 32 字节密钥。
- 内容采用上游 `sealed-tunnel-v1` 的 HMAC 握手、HKDF-SHA256 派生和 AES-256-GCM；检查方向、会话和严格单调序号。中继不持有解密密钥。此 PSK 方案没有前向保密。
- HTTP 上传和下载分块并确认，单文件上限 256 MiB；普通 RPC 响应限 16 MiB、Host mux 单帧限 4 MiB。服务和客户端都有有界队列，超限断开并明确报错。
- 重连重新握手，历史恢复沿用 DSH 的 snapshot/follow 和游标机制。写操作不会被隧道自动重试；prompt 使用 DSH 的稳定 requestId 去重。
- DSH 0.2.0-rc.1 Gateway 已广播待审批和提问，并在一端回答后向其他端发出撤回通知。测试直接验证安装版 Gateway 的此行为，因此没有再增加第二套审批存储。
- 麒麟本身尚未适配的 Computer Use / Chrome 登录接入不会由远程模块补齐。手机控制的是 Host 已有能力。

源码和本机验证不等于三平台安装包或真机验证。Windows、麒麟系统密钥环、托盘以及公网代理部署需要在相应环境验收；本次实现不会自动部署或发布。
