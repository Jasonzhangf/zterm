# Relay Account + TURN Verification Plan

## 索引概要
- L1-L8 `purpose`：目标、边界与唯一真源。
- L10-L26 `config-contract`：测试账号与服务器配置契约。
- L28-L48 `server-gates`：claw/relay 服务端验证门禁。
- L50-L65 `global-release-daemon-flow`：真实 daemon 的全局发行安装与 relay 配置。
- L67-L94 `account-device-flow`：同账号多设备可见性验证。
- L96-L120 `turn-relay-flow`：WebRTC + TURN relay-only 验证。
- L122-L133 `evidence`：证据落盘与通过标准。

## Purpose
目标是验证：同一个 relay 测试账号在不同客户端登录后，可以看到该账号下所有 client 与 daemon 设备；任一客户端可选中在线 daemon，并通过 relay signaling + TURN 中继完成 RTC data channel 连接。

边界：本计划只验证 relay 控制面、daemon host presence、client device presence、RTC signaling、TURN relay-only 连通性；不验证 terminal renderer/buffer 语义。

唯一真源：账号、设备列表、WS endpoint、TURN credential 均来自 relay 控制面登录响应；客户端和 daemon 不得硬编码公网地址、用户名、密码或 TURN 凭证。

## Config Contract
测试账号必须是专用账号，例如 `zterm-relay-smoke`，密码只放在本地 secret 或 CI secret，不进入仓库。

远端验证脚本只允许读取这些环境变量：

```bash
export RELAY_BASE_URL='https://<relay-host>/relay/'
export RELAY_USERNAME='zterm-relay-smoke'
export RELAY_PASSWORD='<secret-from-local-or-ci-secret>'
```

relay server 的 TURN 下发只允许来自服务端环境变量：

```bash
export ZTERM_TURN_URL='turn:<turn-host>:3478?transport=udp'
export ZTERM_TURN_USERNAME='<turn-user>'
export ZTERM_TURN_CREDENTIAL='<turn-secret>'
```

禁止事项：不得在 `android/scripts/`、`android/src/`、文档示例以外的代码中写入真实账号、真实密码、真实 TURN secret。

## Server Gates
1. DNS 门禁：`RELAY_BASE_URL` 的 host 必须解析到 claw 当前公网入口。
2. HTTP 门禁：`GET ${RELAY_BASE_URL}health` 返回 `ok=true`，且 `basePath` 与 `/relay` 一致。
3. 登录门禁：`POST ${RELAY_BASE_URL}api/auth/login` 使用测试账号成功返回 `accessToken`。
4. WS 门禁：登录 payload 必须返回 `ws.devices`、`ws.host`、`ws.client`，协议在 HTTPS 入口下必须是 `wss:`。
5. TURN 门禁：登录 payload 必须返回 `turn.url`、`turn.username`、`turn.credential`；缺任一项都不能宣称 TURN 可用。
6. 端口门禁：TURN UDP 端口必须从外网可达；TCP 探测不能替代 UDP TURN 验证。

## Global Release Daemon Flow
真实 Mac daemon 验证必须走全局发行路径，不能把手工修改迁移前 JSON 配置当成最终交付：

1. 构建发行包：`pnpm run daemon:prepare-release`。
2. 安装或升级：运行 `release-dist/zterm-daemon-<version>-darwin-arm64/bin/install-global.sh`，由它写入 `~/.local/bin/zterm-daemon` 与 `~/.local/bin/wterm`。
3. 配置 relay：使用 `zterm-daemon configure-relay --relay-url "$RELAY_BASE_URL" --username "$RELAY_USERNAME" --password-stdin --host-id <stable-host-id> --device-id <stable-device-id> --device-name <display-name>`；密码只能来自 local/CI secret，输出只能显示 `passwordSet=true`。
4. 启动/重启 daemon：使用全局 `zterm-daemon start|restart|install-service`。当前实现读取迁移前的 `~/.zterm/config.json`；目标实现完成校验、原子迁移和 read-back verification 后只读取 `~/.zterm/config.toml`。daemon 不承担账号登录 UX。
5. 发行包必须包含 RTC native 依赖：`runtime/node_modules/@roamhq/wrtc` 与当前平台 `runtime/node_modules/@roamhq/wrtc-<platform>-<arch>/wrtc.node`；源码环境可运行不能替代安装态验证。
6. 真实双机通过标准：`/relay/health` 中 `liveDaemonDevices>=2`，且 `/api/devices` 同账号下同时出现目标 hostId，例如 `mac-studio` 与 `macbook-air`。

## Account Device Flow
1. 清理本地测试态，只清理脚本临时目录，不删除生产 store。
2. 使用测试账号登录 relay 控制面，保存 `accessToken` 到进程内变量。
3. 启动一个临时 daemon，环境变量写入：

```bash
ZTERM_TRAVERSAL_RELAY_URL=$RELAY_BASE_URL
ZTERM_TRAVERSAL_USERNAME=$RELAY_USERNAME
ZTERM_TRAVERSAL_PASSWORD=$RELAY_PASSWORD
ZTERM_TRAVERSAL_HOST_ID=smoke-host-<timestamp>
ZTERM_TRAVERSAL_DEVICE_ID=smoke-daemon-<timestamp>
ZTERM_TRAVERSAL_DEVICE_NAME=smoke-daemon
```

4. 轮询 `GET ${RELAY_BASE_URL}api/devices`，直到出现该 daemon device，且 `daemon.connected=true`、`daemon.hostId` 等于本轮 `ZTERM_TRAVERSAL_HOST_ID`。
5. 打开第二个 client device stream：`ws.devices?token=<access>&deviceId=smoke-client-<timestamp>`。
6. 再次读取 `/api/devices`，必须同时看到 daemon device 与 client device，且二者属于同一 `userId` 返回范围。
7. 关闭 client stream 后，client device 应变为 `client.connected=false`；关闭 daemon 后，daemon device 应变为 `daemon.connected=false`。

## TURN Relay Flow
1. 从登录 payload 读取 `ws.client` 与 TURN 配置，不从本地硬编码 TURN。
2. 用 `ws.client?token=<access>&hostId=<daemon-host-id>` 建立 signaling WebSocket。
3. 可选先跑普通 RTC：`iceTransportPolicy=all`，只验证 signaling 与 daemon RTC bridge/P2P 可用，不能作为产品 Relay 通过证据。
4. 必须跑中继 RTC：client 与 daemon RTC bridge 都使用 `iceTransportPolicy=relay`，验证 TURN 服务器真实可用。
5. relay-only 通过标准：RTC data channel open，并且 selected candidate pair 中本地 candidate type 为 `relay`。
6. 生产 `rtc-relay` 连接使用 `iceTransportPolicy=relay` 消费同一个 relay signaling + TURN 配置；direct/Tailscale/P2P 必须作为单独 direct/Auto candidate，不得混进 Relay candidate。
7. 若普通 RTC 通过但 relay-only 失败，结论只能是 TURN 配置/网络未验证通过，不能宣称 off-network TURN 闭环，也不能把“标准 ICE 可通”冒充“Relay/TURN 可用”。
8. 若 `/ws/client` 报 `host offline`，先修 daemon `/ws/host` presence，不修改 client 连接逻辑。

## Evidence
每次远端验证必须落盘到 `android/evidence/relay-turn/YYYY-MM-DD/<run-id>/`：

- `health.json`：relay health 响应。
- `login.redacted.json`：登录响应，必须打码 `accessToken` 与 TURN credential。
- `devices-before.json`、`devices-online.json`、`devices-after-close.json`：设备状态变化。
- `rtc-result.json`：包含 `p2p`、`relayOnly`、candidate type。
- `daemon.log`：临时 daemon 日志尾部。

完成定义：以上证据齐全，且 `/api/devices` 多设备可见、普通 RTC 通过、relay-only RTC 通过。否则只能汇报具体失败门禁，不能宣称 relay/TURN 能力已验证。
