---
name: zterm-cli
description: 使用本地已登录的 zterm CLI 非交互式执行远端命令（zterm exec）、CRUD 管理远端 session（zterm session list/create/rename/delete）、非交互式绑定槽位（zterm slot set --device）、查看设备/IP/OS/终端能力（zterm list）、一键安装自带 skill（zterm skill install），以及通过 PTY 打开交互式会话；包含离线包备份部署（~/Documents/server/zterm-releases/）与 zterm app 跨机消息通道。
---

# zterm CLI 远程会话、非交互执行与部署指南

使用本机已安装的 `zterm`（`@jsonstudio/zterm-cli`）连接已登录账号下的远端 `zterm-daemon` / `zterm-daemon-lite`，支持：
- `zterm list`：查看所有机器在线状态、IP/endpoint、操作系统/终端/版本及槽位绑定；
- `zterm exec`：无需本地 `tmux`，直接非交互式在远端会话执行命令并返回 stdout 与真实退出码；
- `zterm session`：在远端完整 CRUD 管理 tmux session（`list` / `create` / `rename` / `delete`）；
- `zterm slot set --device ...`：按主机名/ID 非交互式绑定槽位（`slot >= 1`，无上限）；
- `zterm skill install`：在新机器安装完 CLI 后一键安装自带 `zterm-cli` skill；
- `zterm <slot>`：在本地 PTY 中打开交互式远端终端。

## 1. 登录与设备/槽位总览

- **登录 Relay**：
  ```sh
  zterm login
  ```
  - Relay 地址与账号凭据见 `~/Documents/server/docs/ACCESS_INVENTORY.md`（配置持久化在 `~/.zterm/config.json`）。
  - 若已有 `~/.zterm/config.json` 中的一次性密码字段，可用 `zterm login --from-config`。
- **查看机器、IP、能力与槽位绑定**：
  ```sh
  zterm list        # 等价于 zterm slot list
  ```
  `deviceName` 按 `<hostname> | <OS> | <terminal> | <version>` 规范命名，可直接判断目标机器能力与可用 shell（例如 `tmux`、OpenWrt `ash`、Windows `PowerShell`）。
- **非交互式管理槽位（无数量上限，`slot >= 1`）**：
  ```sh
  zterm slot set <slot> --device <nameOrId> [--session <name>] [--alias <name>] [--width-mode adaptive-phone|mirror-fixed]
  zterm slot rename <slot> <name>
  zterm slot pull <slot> | --all
  zterm slot push <slot> | --all
  ```

## 2. 非交互式执行命令（`zterm exec`，推荐给 Agent）

不需要本地 `tmux`，直接获取干净输出和退出码（默认超时 `30000` ms，超时退出码 `124`）：

```sh
# 按槽位执行
zterm exec 2 -- uname -a

# 按设备名直连（无需预先绑定槽位），并指定目标 session
zterm exec --device coder2 --session main --timeout 15000 -- "ls -la /tmp"

# 长耗时命令（构建、包安装、下载、跨区探测等预计 >30s）务必显式加大 --timeout（单位毫秒）
zterm exec 3 --timeout 120000 -- "apt-get update && systemctl restart xray"

# Windows PowerShell 设备自动适配 PowerShell 退出码包裹
zterm exec --device jason-hw-desktop -- "Get-Service ZTermDaemon"
```
- **长耗时命令策略**：若命令可能超过 `30s`，**必须**主动传入 `--timeout 60000` / `120000`（或更高）；若属于更长任务（数分钟以上），建议在支持 `tmux` 的机器上用 `zterm session create` 建独立后台 session 执行，再用 `zterm exec` 轮询结果。
- **跨区直连抖动兜底**：若本机直连某节点（如 DERP 抖动）失败，可通过 `coder2` 或 `hk-vps` 的 `zterm exec` 跳板访问。

## 3. 完整 CRUD 管理远端 Sessions（避免多任务串流）

在支持 `tmux` 的机器（如 `coder2`、`macbookair`）上，可按任务新建、重命名、查看与删除独立 session，互不干扰：

```sh
zterm session list --device coder2
zterm session create --device coder2 patrol-task --cwd ~/code
zterm session rename --device coder2 patrol-task patrol-v2
zterm exec --device coder2 --session patrol-v2 -- "git status"
zterm session delete --device coder2 patrol-v2
```
- 也可传 `<slot>` 替代 `--device <nameOrId>`（例如 `zterm session list 2`）。
- 注：OpenWrt 上的 `zterm-daemon-lite` 默认提供单个 `main` `ash` 会话，不支持动态增删/重命名 tmux session，对同一路由器执行命令请串行调用 `zterm exec`。

## 4. 一键安装自带 Skill（新机器部署后执行）

`@jsonstudio/zterm-cli` 内置本 Skill 与 `README.md`：
```sh
zterm skill install                 # 默认安装到 ~/.agents/skills、~/.gemini/config/skills、~/.codex/skills
zterm skill install --target project --dir /path/to/repo
zterm skill show                    # 打印内置 SKILL.md 内容
```

## 5. 交互式打开远端 Command CLI（标准 PTY 方式）

需要长时间交互式操作（如 `top`、`vim`）时，`zterm <slot>` 必须在真实 PTY 中运行（推荐用 `tmux` 或 `rex` pane 托管）：

```sh
tmux new-session -d -s zterm-remote -x 120 -y 36 "zterm <slot>"
tmux capture-pane -t zterm-remote -p
tmux send-keys -t zterm-remote -l "<command>"
tmux send-keys -t zterm-remote Enter
tmux capture-pane -t zterm-remote -p -S -100
# 安全断开本地连接（不关闭远端会话）：
tmux send-keys -t zterm-remote C-] q
```

## 6. 新机器部署 CLI 与 Daemon（离线 Release 备份）

所有 release 产物统一备份在 `~/Documents/server/zterm-releases/`（详见 `~/Documents/server/zterm-releases/README.md`）：

- **安装 CLI（含自带 `README.md` 与 `zterm skill install`）**：
  - `~/Documents/server/zterm-releases/cli-0.1.6/jsonstudio-zterm-cli-0.1.6.tgz`
  - 离线安装：`npm install -g ./jsonstudio-zterm-cli-0.1.6.tgz && zterm skill install`
- **macOS / Linux / Windows（完整版 `zterm-daemon` 0.1.6，需 Node.js 22+）**：
  - `~/Documents/server/zterm-releases/daemon-0.1.6/`（主包 + `darwin-arm64` / `linux-x64` / `win32-x64`）
  - 离线安装：`npm install -g <main.tgz> <platform.tgz>`，配置 `~/.zterm/config.json` 与 `<hostname> | <OS> | <terminal> | <version>` 格式的 `deviceName`。
- **OpenWrt / 轻量 Linux x86_64（`zterm-daemon-lite` 0.1.6，纯 Rust 静态二进制）**：
  - `~/Documents/server/zterm-releases/daemon-lite-0.1.6/zterm-daemon-lite-0.1.6-linux-x86_64-musl`
  - 拷贝到 `/usr/bin/zterm-daemon-lite` 并 `chmod +x`，通过 `procd` 或 `systemd` 常驻运行。
  - **OpenWrt 防火墙注意**：`daemon-lite` 会在 `:3333` 提供 Tailscale/LAN WebSocket mux；若 OpenWrt 的 `tailscale` zone 默认 `input='REJECT'`，需放行 `100.64.0.0/10`（及 `fd7a:115c:a1e0::/48`）到本机 TCP `3333`。
- **传输加密**：`zterm` 与 `zterm-daemon` / `zterm-daemon-lite` 默认走 WebRTC DTLS-SCTP 端到端加密通道（`lan -> rtc-direct -> tailscale -> rtc-relay`），不走明文公网 `ws://`。

## 7. 结构化跨机消息/文件通道（大文件传输推荐）

大配置文件/脚本建议用 `zterm app send-file`，避免在终端里粘贴超长文本：
```sh
zterm app stream --json
zterm app send --peer <deviceId> [--daemon-host-id <hostId>] --subject <text> --body <text>
zterm app send-file --peer <deviceId> [--daemon-host-id <hostId>] --file <path>
zterm app ack --message-id <id>
zterm app consume --message-id <id>
```
