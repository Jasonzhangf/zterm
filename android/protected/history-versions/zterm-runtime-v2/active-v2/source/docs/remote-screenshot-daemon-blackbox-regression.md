# Remote Screenshot Daemon Black-Box Regression

## 索引概要
- L1-L7 `purpose`：本文件定义 remote screenshot 改造前必须先落地的黑盒回归。
- L9-L24 `contract`：用户可观察契约与禁止项。
- L26-L54 `cases`：安装态、运行态、错误态、打包态回归场景。
- L56-L66 `evidence`：实现完成前后的验证证据。

## 目标

Remote screenshot 的用户契约是：安装 `zterm-daemon` 时完成 macOS 截图权限申请 / 预检；安装完成后 Android 通过 daemon 请求截图即可长期使用，不需要另装或启动本地 Codex Mac / ZTerm Mac GUI helper。

## 黑盒契约

- Android 只看到 `capturing -> transferring -> preview-ready | failed`，不看到 helper/socket/app 模式细节。
- Mac 用户只安装并管理 `zterm-daemon`，不需要启动第二个 GUI helper 进程。
- `zterm-daemon install-service` 是截图权限预检与授权触发入口。
- `install-service` 不能每次重编 `zterm-daemon` 原生截图主体；只有二进制缺失或源码更新时才重建，避免 macOS 反复确认新的权限主体。
- `zterm-daemon service-status` 必须能暴露截图能力是否 ready / denied / unsupported。
- daemon 截图失败必须显式返回 daemon 权限/显示器/平台错误，禁止提示“启动 Mac helper”。
- 打包后的全局 daemon 与源码脚本必须有同一套安装态权限行为。

## 回归场景

### Case A：安装态权限预检

1. 用户运行 `zterm-daemon install-service`。
2. 安装流程在 bootstrap 前执行截图权限 preflight。
3. macOS 若弹出权限申请，申请主体必须归属 daemon 安装态 runtime，而不是 Codex / ZTerm Mac helper。
4. 安装命令不能在截图权限未确认时静默成功。

### Case B：安装后长期可用

1. 完成 `install-service` 后，不启动任何 Codex Mac app / ZTerm Mac GUI helper。
2. Android 点击 remote screenshot。
3. daemon 返回 `capturing -> transferring -> file-download-* -> preview-ready`。
4. 重启 daemon / logout-login 后重复截图仍走同一 daemon 能力。

### Case C：权限拒绝错误

1. macOS 截图权限被拒绝或未授权。
2. Android 点击 remote screenshot。
3. UI 显示 daemon 截图权限错误与修复指引。
4. 错误信息不得包含 helper/socket/另装 Mac app 语义。

### Case D：打包态一致性

1. 运行 release/全局 daemon 安装产物。
2. `zterm-daemon install-service` 与源码 `scripts/zterm-daemon.sh install-service` 的截图 preflight 行为一致。
3. 不允许源码脚本支持截图权限，而 release 脚本漏掉。

### Case E：协议不变

1. Android 仍只发 `remote-screenshot-request`。
2. daemon 仍用既有 `remote-screenshot-status` 与 `file-download-*` 回传。
3. 只替换 daemon 内部截图执行 owner，不改 Android preview/save 协议。

## 自动门禁

对应红测入口：`src/server/remote-screenshot-daemon-blackbox.test.ts`。

该测试当前必须失败，用来证明旧 helper 设计仍存在；实现完成后它必须转绿，并与真实 `install-service + Android screenshot smoke` 证据一起作为完成门禁。

## 完成证据

- 红测先失败的输出。
- 实现后红测转绿的输出。
- `zterm-daemon install-service` 输出与 service-status 输出。
- 不启动任何 Mac GUI helper 时，Android remote screenshot 成功预览的截图/日志。
- 拒绝截图权限时，Android 端显示 daemon 权限错误的截图/日志。
