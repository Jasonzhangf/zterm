---
name: zterm-cli
description: 使用本地已登录的 zterm CLI 直接打开远端主机终端会话（slot，无数量上限），查看设备/IP/OS/终端能力（zterm list），向远端 command CLI 发送输入、读取输出并安全退出；包含离线包备份部署（~/Documents/server/zterm-releases/）与 zterm app 跨机消息通道。
---

# zterm CLI 远程会话、设备查询与部署指南

使用本机已安装的 `zterm`（`@jsonstudio/zterm-cli`）连接已登录账号下的远端 `zterm-daemon` / `zterm-daemon-lite` 会话，在本地 PTY 中直接向远端 command CLI 发送输入、读取回显与安全退出；也可通过 `zterm list` 一览所有机器的在线状态、IP/endpoint、操作系统/终端/版本以及槽位绑定。

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
  `zterm list` 会输出：
  1. **已配置槽位**（`slot >= 1`，无 20 个上限）：槽位号、本地别名、绑定的设备/session、在线状态与可用 IP/endpoint。
  2. **Relay 设备目录**：每台机器的 `deviceName`（按 `<hostname> | <OS> | <terminal> | <version>` 规范命名，可直接判断目标机器能力与可用 shell/tmux）、`deviceId`、daemon/client 在线状态、IP/endpoint、已绑定槽位和活跃 sessions。
- **管理槽位（无数量上限）**：
  ```sh
  zterm slot set <slot> [--width-mode adaptive-phone|mirror-fixed]
  zterm slot rename <slot> <name>
  zterm slot pull <slot> | --all
  zterm slot push <slot> | --all
  ```

## 2. 打开远端 Command CLI 并输入（标准 PTY 方式）

`zterm <slot>` 会进入终端 raw mode 与 alternate screen，**必须在真实 PTY 中运行**（不可用无 TTY 的普通管道 stdin）。推荐使用独立 `tmux` 会话或 `rex` pane 托管 `zterm <slot>`：

1. **查看可用槽位与机器能力**
   ```sh
   zterm list
   ```
   根据 `deviceName` 中的终端类型选择命令语法（例如 `tmux` / Linux bash、OpenWrt `ash`、Windows `PowerShell`）。

2. **在独立本地 PTY（tmux）中打开远端槽位**
   ```sh
   tmux new-session -d -s zterm-remote -x 120 -y 36 "zterm <slot>"
   ```
   等待片刻后检查远端 mirror 是否已渲染就绪：
   ```sh
   tmux capture-pane -t zterm-remote -p
   ```

3. **向远端 Command CLI 发送输入**
   使用 `tmux send-keys` 向本地 PTY 写入命令并回车（`zterm` 会将按键转发到远端 session）：
   ```sh
   tmux send-keys -t zterm-remote -l "<command>"
   tmux send-keys -t zterm-remote Enter
   ```
   等待命令执行后读取输出：
   ```sh
   tmux capture-pane -t zterm-remote -p -S -100
   ```
   - 其他交互快捷键：`Ctrl+]` 后按 `k/j/u/d/h/l/f` 可在本地翻页、横向平移或回到 follow 模式。
   - 不要在普通文本中误发 `Ctrl+] q`。

4. **本地安全退出（不关闭远端会话）**
   ```sh
   tmux send-keys -t zterm-remote C-] q
   ```
   `Ctrl+] q` 只断开本地 `zterm` 连接并恢复本地终端状态，不会停止或删除远端 session。

## 3. 新机器部署 Daemon（离线 Release 备份）

所有 release 产物统一备份在 `~/Documents/server/zterm-releases/`（详见 `~/Documents/server/zterm-releases/README.md`）：

- **macOS / Linux / Windows（完整版 `zterm-daemon` 0.1.6，需 Node.js 22+）**：
  - 备份路径：`~/Documents/server/zterm-releases/daemon-0.1.6/`
    - `jsonstudio-zterm-daemon-0.1.6.tgz`
    - `jsonstudio-zterm-daemon-darwin-arm64-0.1.6.tgz`
    - `jsonstudio-zterm-daemon-linux-x64-0.1.6.tgz`
    - `jsonstudio-zterm-daemon-win32-x64-0.1.6.tgz`
  - 部署步骤：将主包与对应平台包拷贝到目标机后离线安装（`npm install -g <main.tgz> <platform.tgz>`），在 `~/.zterm/config.json` 中设置能体现系统/终端/版本的 `deviceName`（例如 `"<host> | Ubuntu 22.04 x64 | tmux | 0.1.6"`）和 Relay 登录凭据，启动 daemon 服务。
- **OpenWrt / 轻量 Linux x86_64（`zterm-daemon-lite` 0.1.6，纯 Rust 静态二进制，无需 Node.js / tmux）**：
  - 备份路径：`~/Documents/server/zterm-releases/daemon-lite-0.1.6/zterm-daemon-lite-0.1.6-linux-x86_64-musl`
  - 部署步骤：拷贝到目标机 `/usr/bin/zterm-daemon-lite` 并 `chmod +x`，写入 `~/.zterm/config.json`（含 `deviceName` 如 `"<host> | OpenWrt x86_64 | ash | lite-0.1.6"`），通过 `procd` 或 `systemd` 常驻运行。
- **路由传输说明**：`zterm` 与 `zterm-daemon` / `zterm-daemon-lite` 默认使用 WebRTC DTLS-SCTP 端到端加密通道（`lan -> rtc-direct -> tailscale -> rtc-relay`），不走明文公网 `ws://`。

## 4. 结构化跨机消息/文件通道（无需 PTY）

若只需向远端机器投递结构化消息或文件（无需交互式 shell）：
```sh
zterm app stream --json
zterm app send --peer <deviceId> [--daemon-host-id <hostId>] --subject <text> --body <text>
zterm app send-file --peer <deviceId> [--daemon-host-id <hostId>] --file <path>
zterm app ack --message-id <id>
zterm app consume --message-id <id>
```
- 外部 app 建议常驻运行 `zterm app stream --json`，从 stdout 读取 NDJSON 事件，向 stdin 写入 NDJSON 指令，避免高频调用短命令重复握手。
