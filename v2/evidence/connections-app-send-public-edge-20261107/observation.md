# connections-app-send-public-edge-20261107 observation

## 目标
新增 connections 公开发送边：`openChannel(link, "message")` + `requestMessage(channel, request)`。发送经真实源 daemon 本地 `/app` 网关，授权目标后发送 V1 `app-send-message`，并等待同 requestId/messageId 的 `app-send-result`/`app-error`。不得把 `targetMachineId` 放上 wire，不得伪造 received，不得在 pre-write/post-write 间误分类。

## 受影响图
- 复用 `android/docs/dagpipe/daemon-app-messaging.graph.json` 的事实边界，不新增业务图。
- 本任务最小正确图：requestMessage(input) → authorize target machine → open source `/app` transport → verify source identity → register pending correlation(v1MessageId) → encode/validate frame → send app-send-message → settle matching result/error → public AppMessageResult。pre-write link/generation failure 不发送；post-write close/timeout 为 unknown。
- 图已闭合：单一输入 AppMessageRequest，单一输出 AppMessageResult；重复 pending key 显式拒绝；无回边。

## 现状
- `V1TraversalTransport` 只声明 terminal；`message` 返回 unsupported_channel（保持）。
- `packages/cli/src/app-connection.ts` 已有 V1 local `/app` 连接器（Bearer、app-hello/app-ready、request correlation），但属 CLI 包，connections 不能直接 import 私有 CLI 源码。
- `createAppCodec` 只负责 validate+JSON，不承载 transport。
- accounts 端口目前仅 `authorizeMachine(machineId)`，无 target 解析。因此需在 connections 注入 `authorizeMessageTarget(machineId)` 扩展，或以第二个端口传入。为最小侵入，可在 AccountsAuthorizationPort 增加可选 `authorizeMessageTarget`？但合同要求 target 由 accounts 解析并返回 AppTarget 端点。契约要求 destination target identity 与 credentials 从 accounts 解析，不能由 caller 提供。由于 accounts 模块当前公开 `AuthorizedMachineLink` 也源自 `authorizeMachine(machineId)`，其 target/settings 已承载 accounts 产物。本任务可通过先 `authorizeMachine(targetMachineId)` 获取目标 `AuthorizedMachineLink`，从中构造 AppTarget（目标身份与端点），再打开 source link。授权顺序必须在 send 前。

## 设计选择
- 新增 AppMessageRequest/AppMessageResult 公开类型（connections）。
- 新增 `adapters/v1-app.ts`：基于注入 WebSocket factory、`createAppCodec`、accounts 授权结果的源网关 `/app` 传输。它会：
  1. `authorizeMachine(sourceMachineId)` 建立源 link；
  2. source link 使用 source `AuthorizedMachineLink` 的本地 endpoint/token、daemonHostId/deviceId?（AuthorizedMachineLink 目前无 deviceId）；
  3. 用 `authorizeMachine(targetMachineId)` 解析 target AppTarget；
  4. 建 `/app` WebSocket、Bearer，发 app-hello(role=local)，等 app-ready；
  5. 校验 ready.daemonHostId 与 source auth.daemonHostId；deviceId 若可用则校验；
  6. openChannel("message") 由 app transport 承载（不再走 terminal mux）；
  7. requestMessage 注册 pending key，encode 发送，等待 matching result/error，超时 unknown；
  8. post-write close/timeout → unknown；pre-write closed/stale → ConnectionError。
- 为最小实现，`ConnectionManager` 增加 `requestMessage(channel, request)`；channel.kind 必须为 message 且当前 connected/generation。
- 目标 AppTarget 构造从 target `AuthorizedMachineLink.target` 派生：
  - deviceId: target.machineId（或 target 的 daemon/device 字段，需确认）
  - daemonHostId: targetAuth.daemonHostId
  - wsUrl/authToken: target.bridgeHost/bridgePort + authToken（若存在）
- 需确认 target auth 是否包含 deviceId（AuthorizedMachineLink 只含 machineId/daemonHostId，无 deviceId）。可能需要扩展 accounts 端口接口或利用 target 结构。仍在探索。
