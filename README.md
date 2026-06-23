# zterm

移动端终端应用，通过 Tailscale / 局域网访问本地 Mac 上的 tmux bridge。
Android 客户端 + macOS daemon。未来 Mac / Windows 客户端。

## Layout

- `android/` — current Android app
- `mac/` — future macOS client
- `win/` — future Windows client

## 快速开始：macOS daemon

### 一键安装

```bash
# 从 GitHub Release 下载并安装
curl -fsSL https://github.com/Jasonzhangf/zterm/releases/latest/download/zterm-daemon-<version>-darwin-arm64.tar.gz | tar xz
cd zterm-daemon-<version>-darwin-arm64
./bin/install-global.sh
```

或者从 npm：

```bash
npm install -g @jsonstudio/zterm-daemon
```

安装后全局可用：

```bash
zterm-daemon install-service   # 安装 launchd 自启服务 + 权限获取
zterm-daemon service-status    # 查看服务状态
zterm-daemon restart           # 重启 daemon
zterm-daemon status            # 查看运行状态
```

### 配置

配置文件 `~/.zterm/config.json`（自动创建）：

```json
{
  "zterm": {
    "android": {
      "daemon": {
        "host": "0.0.0.0",
        "port": 3333,
        "authToken": "your-secret-token"
      }
    }
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `host` | `0.0.0.0` | daemon 监听地址 |
| `port` | `3333` | daemon 监听端口 |
| `authToken` | 空（关闭鉴权） | WebSocket 鉴权 token |
| `terminalCacheLines` | `3000` | 终端 scrollback 缓存行数 |

### Relay（远程穿透）

如果手机和 Mac 不在同一局域网，需要配置 relay 服务：

```bash
zterm-daemon configure-relay \
  --relay-url https://your-relay-server/relay/ \
  --username your-username \
  --password your-password \
  --host-id mac-studio \
  --device-name "Mac Studio" \
  --restart-service
```

Relay 会在 daemon 启动时自动注册，手机端在连接配置中可通过 relay 连上 Mac。

### 目录结构

```text
~/.zterm/
├── config.json          # daemon 配置 + relay 配置
├── daemon-id            # daemon 唯一标识
├── schedules.json       # 定时发送任务
├── logs/                # daemon + launchd 日志
├── run/                 # PID 文件 + crash guard
├── tmux/                # tmux socket 目录（如果 daemon 启动 tmux server）
├── uploads/             # 文件上传缓存
├── updates/             # APK 更新包 + latest.json
└── releases/            # daemon 版本隔离目录（多版本共存）
    └── <version>/
        ├── runtime/     # bundled server.cjs + node_modules
        ├── support/     # zterm-daemon.sh + native binary
        └── bin/         # install-global.sh
```

## Android APK

从 GitHub Releases 下载最新 APK 直接安装，或通过 daemon 的 update channel 自动升级。

### 连接配置

1. 打开 App → Connections
2. 点击右下角 `+`
3. 输入 Mac 的 Tailscale IP 或局域网 IP
4. 输入 daemon 端口（默认 `3333`）和 authToken（如配置了鉴权）
5. 点击 Connect → 选择 tmux session
6. 保存主机

### 升级链路

APK 更新由 daemon 的 HTTP 服务提供：

- `http://<daemon-host>:3333/updates/latest.json` — 升级清单
- `http://<daemon-host>:3333/updates/zterm-<version>.apk` — APK 下载

发布新 APK 后，更新 `android/update-dist/latest.json`，daemon 重启后自动对外提供最新版本。

## 开发

详见 `android/README.md`。

### 依赖

- Runtime: `@jsonstudio/wtermmod-core`, `@jsonstudio/wtermmod-dom`, `@jsonstudio/wtermmod-react`
- Runtime 源码在 `../wterm`，本仓库只安装 npm 发布版本
- Android 构建：Capacitor + `@jsonstudio/wtermmod-react`
- macOS daemon：Node.js + tmux + node-pty

### 真源文档

- `android/docs/spec.md` — 产品范围
- `android/docs/architecture.md` — 模块边界
- `android/docs/decisions/` — 关键设计决策
- `android/docs/dev-workflow.md` — 开发门禁
