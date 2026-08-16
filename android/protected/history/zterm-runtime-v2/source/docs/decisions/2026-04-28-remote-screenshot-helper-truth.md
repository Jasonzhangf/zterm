# 2026-04-28 remote screenshot daemon truth

## 索引概要
- L1-L7 `purpose`：废弃旧 helper 方案，冻结 daemon 安装态/运行态为唯一真源。
- L9-L25 `superseded`：旧 helper 方案为什么不再成立。
- L27-L51 `truth`：daemon/client/macOS 职责边界。
- L53-L70 `errors`：错误边界与禁止 fallback。

## 废弃说明

旧方案曾把 remote screenshot 拆到独立 GUI 截图进程。

该方案已废弃。原因：产品契约要求用户只安装并授权 `zterm-daemon`；安装完成后 Android remote screenshot 必须长期可用，不得依赖 Codex Mac app、ZTerm Mac GUI app、独立后台截图进程或本机 IPC socket。

## 唯一真源

### daemon

- 是 remote screenshot 权限预检与截图执行的唯一 owner。
- `zterm-daemon install-service` 必须在 service bootstrap 前触发/验证 macOS 截图权限。
- remote screenshot request 到达后，daemon 直接执行本机截图，并通过既有 file-download stream 回传。
- daemon 只关心本机截图文件、显式错误和传输分块；不关心 Android preview/save UI。

### client

- 只发送 `remote-screenshot-request`。
- 只消费 `capturing -> transferring -> preview-ready | failed`。
- 不关心 macOS 权限细节、截图命令或 daemon 内部执行方式。

### macOS

- macOS TCC 权限授予对象必须是安装态 daemon runtime 对应的进程身份。
- 权限拒绝、无显示器、非 macOS 平台都必须显式返回错误。

## 运行模型

```text
Android client
  -> zterm-daemon
  -> macOS screenshot truth
  -> daemon file-download stream
  -> Android preview/save
```

## 错误边界

- daemon 截图权限未授权：显式返回 daemon 截图权限错误。
- 当前显示器不可截图：显式返回 daemon 显示器截图错误。
- 非 macOS：显式返回 unsupported platform。
- 禁止 fallback 到本机 IPC socket、第二进程或静默 loading。
- 禁止提示用户启动 Codex Mac app、ZTerm Mac GUI app 或独立截图进程。
