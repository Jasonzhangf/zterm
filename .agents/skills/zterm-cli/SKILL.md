---
name: zterm-cli
description: 使用本地已登录的 zterm CLI 直接打开远端主机终端会话（slot），向远端 command CLI 发送输入、读取输出并安全退出；也覆盖 zterm app 跨机消息与文件通道。
---

# zterm CLI 远程会话与输入指南

使用本机已安装的 `zterm`（`@jsonstudio/zterm-cli`）连接已登录账号下的远端 `zterm-daemon` 会话，并在本地 PTY 中直接向远端 command CLI 发送输入、读取回显与安全退出。

## 前置条件

- 本机已安装 `zterm`（Node.js 22+）并完成 `zterm login`（配置位于 `~/.zterm/config.json`）。
- 远端机器已运行 `zterm-daemon` 并已绑定槽位（`1..20`）；若本机无槽位，可先用 `zterm slot pull --all` 或 `zterm slot set <1..20>` 绑定。
- 严禁猜测服务器地址、token 或 session ID；始终以 `zterm slot list` 的本地绑定为准。

## 打开远端 Command CLI 并输入（标准 PTY 方式）

`zterm <1..20>` 会进入终端 raw mode 与 alternate screen，**必须在真实 PTY 中运行**（不可用无 TTY 的普通管道 stdin）。推荐使用独立 `tmux` 会话或 `rex` pane 托管 `zterm <slot>`：

1. **查看可用槽位**
   ```sh
   zterm slot list
   ```

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

## 结构化跨机消息/文件通道（无需 PTY）

若只需向远端机器投递结构化消息或文件（无需交互式 shell）：
```sh
zterm app stream --json
zterm app send --peer <deviceId> [--daemon-host-id <hostId>] --subject <text> --body <text>
zterm app send-file --peer <deviceId> [--daemon-host-id <hostId>] --file <path>
zterm app ack --message-id <id>
zterm app consume --message-id <id>
```
- 外部 app 建议常驻运行 `zterm app stream --json`，从 stdout 读取 NDJSON 事件，向 stdin 写入 NDJSON 指令，避免高频调用短命令重复握手。
