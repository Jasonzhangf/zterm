# Relay Server Independent Release Plan

## 结论

Claw relay server 需要独立发行包，不能复用或混入 `@jsonstudio/zterm-daemon`。理由：
- daemon 是用户 Mac 上的 host bridge，只读 `~/.wterm/config.json`，生命周期属于用户机器。
- relay server 是公网控制面，负责账号、设备 presence、WS signaling、TURN credential 下发，生命周期属于服务器部署。
- 两者配置真源、权限边界、升级节奏和运行环境完全不同；合包会让用户机器获得不需要的 server 能力，也会让服务器部署依赖 Mac daemon 包语义。

## 推荐发行形态

第一阶段推荐 npm 包 + systemd 模板：`@jsonstudio/zterm-relay-server`。

后续可补 Docker image，但 Docker 不是第一阶段唯一真源，避免同时维护两条部署路径。

## 包职责

`@jsonstudio/zterm-relay-server` 只包含：
- compiled relay server runtime from `android/src/traversal-relay/server.ts`。
- CLI bin：`zterm-relay-server`。
- config/env validation：启动前检查必要 env 与 secret。
- deploy smoke：`zterm-relay-server smoke --base-url ...` 或独立脚本。
- systemd unit / nginx sample / env sample 文档。

不包含：
- Mac tmux daemon。
- Android APK。
- 测试账号密码、TURN credential、生产 store。
- 客户端 UI 或 renderer 逻辑。

## 配置契约

运行时只接受 env/secret，不写入仓库：

```bash
ZTERM_TRAVERSAL_HOST=127.0.0.1
ZTERM_TRAVERSAL_PORT=19090
ZTERM_TRAVERSAL_BASE_PATH=/relay
ZTERM_TRAVERSAL_STORE_PATH=/var/lib/zterm-relay/store.json
ZTERM_TURN_URL=turn:claw.codewhisper.cc:3479?transport=udp
ZTERM_TURN_USERNAME=<secret>
ZTERM_TURN_CREDENTIAL=<secret>
```

反向代理负责公网 TLS 与 path routing，例如：
- public: `https://claw.codewhisper.cc:18443/relay/`
- local upstream: `http://127.0.0.1:19090/relay/`

## 验证门禁

本地包门禁：
- `npm pack` tarball 包含 `bin/zterm-relay-server` 与 compiled server runtime。
- 启动时缺 TURN env 必须显式显示 `turn disabled` 或 fail-fast 策略，不能伪造 TURN 可用。
- store path 不存在时只创建目标目录与 store 文件，不覆盖现有 store。

Claw 部署门禁：
- `GET /relay/health` 返回 `ok=true`、`basePath=/relay`。
- 登录测试账号成功，返回 `accessToken`、`ws.host`、`ws.client`、`ws.devices`。
- 登录 payload 返回 `turn.url`、`turn.username`、`turn.credential`。
- Mac Studio + MacBook Air 通过 registry daemon 包连入后，`liveDaemonDevices>=2`。
- 强制 `iceTransportPolicy=relay` 对两台 daemon 均通过，local candidate type 为 `relay`。

## 最小实施步骤

1. 新增 `android/scripts/prepare-relay-server-npm-package.mjs`，用 esbuild 打包 `src/traversal-relay/server.ts` 为 Node CJS runtime。
2. 生成 npm package：`@jsonstudio/zterm-relay-server`，bin 指向 wrapper。
3. 新增 package README，写明 env contract、systemd 示例、nginx/TLS 反代示例与 smoke 命令。
4. 新增 release verify：检查 relay server tarball 内容，不与 daemon tarball 混淆。
5. 在 Claw 用 npm package 安装到独立目录，使用现有 secret/env 启动。
6. 复跑 relay health、login、device list、TURN relay-only evidence。

## 暂停点

与 daemon 包相同：只有本地 package/tarball/verify 全部完成、必须执行 `npm publish @jsonstudio/zterm-relay-server` 时暂停给 Jason 发布；发布后继续在 Claw 从 npm registry 安装并验证。
