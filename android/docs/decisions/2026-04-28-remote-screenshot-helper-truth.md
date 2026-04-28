# 2026-04-28 remote screenshot helper truth

## 背景

Android client 的 remote screenshot 链路原本是：

```text
client -> daemon -> screencapture -> daemon -> client
```

现场实证表明这条链路不成立：

- 交互 shell 里直接执行 `screencapture` 成功
- shell 里 `launchctl asuser ... screencapture` 成功
- daemon launchd job / bootstrap 上下文里直接执行 `screencapture` 失败
- `bsexec` 到 daemon 当前进程 bootstrap 后依旧失败

结论：

> 问题不在命令本身，而在 **launchd daemon job 不是正确的截图执行主体**。

## 唯一真源

### 职责边界

#### daemon

- 只负责：
  - 接收 client screenshot request
  - 转发给本机 GUI screenshot helper
  - 读取 helper 产出的文件
  - 通过既有 `file-download-*` 链路回传给 client
- **不得**再直接执行 `screencapture`

#### GUI screenshot helper

- 必须是运行在 macOS GUI session 的独立 app 进程
- 是截图能力的唯一执行主体
- 只负责：
  - 接受本机 daemon 的 capture request
  - 执行系统截图
  - 返回 started / completed / failed
- **不得**关心 tmux / session / renderer / client buffer

#### client

- 只消费 `capturing -> transferring -> preview-ready | failed`
- 不关心 helper 细节

## 运行模型

```text
Android client
  -> daemon
  -> GUI screenshot helper (local IPC)
  -> macOS screenshot truth
  -> daemon file-download stream
  -> Android preview/save
```

## IPC 真相

- daemon 与 helper 通过 **本机单一 IPC 真源** 通信
- 第一版使用 Unix domain socket
- socket 只允许本机访问
- 一次 capture request 只对应一个 response lifecycle：
  - `capture-started`
  - `capture-completed`
  - `capture-failed`

## 错误边界

- helper 未运行：显式错误
- helper capture 失败：显式错误
- daemon 不允许 fallback 到直接 `screencapture`
- client 不允许继续伪 loading

## 第一版实现冻结

1. daemon 改为 **只走 helper**
2. helper 第一版内部仍可调用 `/usr/sbin/screencapture`
3. 先跑通最小闭环，再决定是否升级到 ScreenCaptureKit

## helper 产品化启动真源

- helper 不是“临时命令”，而是 **独立 GUI 常驻进程**
- 第一版产品化启动方式冻结为：
  - 通过 mac 本机 `launchd LaunchAgent` 自启动 helper
  - helper 进程主体仍是 **Electron app 的 `--screenshot-helper` 模式**
  - LaunchAgent 只负责拉起 helper，不承载截图语义
- helper 必须保留**可观测入口**
  - 至少能 `status / start / stop / restart`
  - helper-only 模式下要有明确的 app 身份与退出入口，不能变成纯黑盒后台进程
- daemon 不负责拉起 helper
  - helper 未运行时，daemon 只能回显式错误
  - 正确修复方式是启动 helper，不是回退到 daemon direct screenshot
