# Android DAGpipe Phase8 设计切片

状态：静态治理设计稿。`android-connection-service.graph.json` 通过
validate/inspect 后，先完成静态独立 review PASS，再进入 Rust Operator/parity/接线。

## 范围

Phase8 覆盖 Android 原生前台连接服务 slice：

- `client.connection_service`：服务 IPC、desired target/channel、服务快照投影。
- `client.android_connection_service`：原生物理 WebSocket、mux、心跳、网络代际、
  backoff 重连、desired channel 重放。
- `client.android_notification_sessions`：前台服务通知投影、通知 action 深链到
  session open、停止会话 action 脉冲。

## 角色与身份

- `client.connection_service`：唯一接收 typed 命令和投影服务快照的客户端边界。
- `client.android_connection_service`：唯一持有物理 transport、mux/channel 生命周期、
  心跳、网络代际、重连/backoff 和 desired route policy 的 owner。
- `client.android_notification_sessions`：只投影通知 action 和消费会话空闲事实，
  不持有 terminal body、renderer、active tab 或 transport 真源。
- Activity/WebView/React：只读快照、发送 typed command、attach/detach 投影；
  foreground/background、pause/resume、Activity 重建不得创建或关闭物理 transport。

## 事件

- UI 发送 typed command：`set-manual-route-policy`、`bind-target`、`release-target`、
  `open-channel`、`close-channel`、`target-message`、`pulse-session-notification`。
- 服务启动/重建：读取持久 desired target/channel，重放绑定和通道打开计划。
- 网络代际事件：网络 observer 触发 target health 校验；旧 generation 事件拒绝。
- 通知 action：`zterm://session/open?targetKey=...&channelId=...&sessionName=...`
  深链到精确 session open。
- daemon `session-activity`：stop 事实只脉冲匹配的已连接 action，不做第二层业务真源。

## 状态机

服务：

- `idle` → `resolving-target` → `connecting` → `mux-ready` → `channels-ready` →
  `healthy`。
- 物理关闭/心跳连续丢失进入 `backoff-reconnect`；下一次尝试由服务 timer/delta 拥有，
  不依赖 UI 生命周期。
- 认证失败进入 `authentication-error`，停止自动重连。
- 显式 release/无 desired target 回 `idle`。

网络代际：

- 每个物理 generation 是服务内部真源；route 变更、物理关闭、认证失败都会终结当前
  generation。
- 新 generation 接收的旧帧/旧心跳不得更新当前 snapshot；只有当前 generation 事件
  才能推进状态。

通知投影：

- 只投影 mux-open 且 body 已订阅的 connected channel；opening/desired/stale 不投影。
- 同一 target/channel 使用稳定 `targetKey + channelId` 身份；最多 3 个 action。
- 同一停止会话只脉冲一次；真实 activity 恢复后才重新武装。

## 单 session 与多 sessions

- 单 service：Android 前台服务进程内只有一个 connection service owner。
- 单 target：一个稳定 daemon target 只维护一条物理 WebSocket。
- 多 session：一个 target 下可打开多个 channel；channel 失败不连坐 sibling channel；
  通知投影按 connected channel 分别生成 action。
- 多 target：服务按 targetKey 隔离 desired target 和 snapshot；UI 快照不能变成
  terminal body/renderer 真源。

## 终态与非法转移

- 显式失败：`command-rejected`、`physical-error`、`heartbeat-timeout`、
  `authentication`、`terminal`。
- 禁止 WebView/Activity lifecycle 直接 reconnect、probe、route-switch、心跳或关闭
  transport。
- 禁止服务快照进入 terminal body、`buffer-sync`、input、file、remote-window 或 debug
  payload。
- 禁止通知 action 打开不存在的 session 或悄悄路由到最近 host；未知目标显式警告。

## TS 接线门禁

- WebView/React 的 foreground-resume、active-reentry、active-tick、passive-visible
  刷新只允许 `request-head` / `buffer-sync` 数据刷新，不得触发 `reconnectSession`
  或 channel reopen。
- 即使旧接线仍把 `foreground-resume` 作为 `notify-target-network-signal` 投递，
  transport orchestration 也只把它当 data-refresh-only：不 probe、不 retire
  physical transport、不 wake scheduled reconnect。
- `ensureActiveSessionFresh` 的 `source` 是唯一重连/通道恢复门禁：只有
  `explicit-resume`（显式用户 resume/switch）才允许打开或重建 transport/channel。
- 连接恢复只属于 `client.android_connection_service` / DAGpipe
  `android.connection_lifecycle.plan_recovery`；UI 状态机不再持有自动重连开关。

## 数据契约

- `resource.client_connection_service_ipc`
- `resource.client_service_snapshot`
- `resource.android_connection_service`
- `resource.android_notification_projection`

## 验收

- `android-connection-service.graph.json` 通过 `dagpipe graph validate/inspect`。
- 扩展后的 dagpipe gate 通过。
- 独立架构 review 对静态设计 PASS 后，才进入 Rust Operator/parity/接线。
- 接线前旧 TS 实现保留；parity 通过后再切换薄 bridge 为 active path。
