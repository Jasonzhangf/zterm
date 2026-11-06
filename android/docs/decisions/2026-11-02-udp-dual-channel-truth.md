# UDP dual-channel physical transport truth
日期：2026-11-02
范围：Android `rtc-direct` 物理 transport 的 `zterm` 控制车道与 `zterm-bulk`
负载车道拆分、协议协商、车道分类、发送流控、buffer-sync 分片续发与 file
transfer 下载 pacing。
## 背景
Android 前台局域网 `rtc-direct` 使用单一有序可靠 DataChannel（`zterm`）。大体积
`buffer-sync` / 文件分块与 `terminal-snapshot-result` 与 mux 握手、target 控制、
channel 生命周期、可靠输入和 ACK 共享同一物理队列。单一通道下高吞吐负载会与
控制帧互相积压：控制帧不得绕过所有队列顺序，但也不应被纯负载长期阻塞。本决策
把物理 DataChannel 拆成两条 ordered-reliable lane：
- `zterm`（control）：mux 握手、target 控制、channel 生命周期、可靠输入、
  ACK、请求、错误与控制帧。物理 transport 的 OPEN/CLOSE/ICE 事实与恢复
  ownership 仍由该 lane 唯一承载。
- `zterm-bulk`（bulk）：高体积负载帧（`buffer-sync`、`file-download-chunk`、
  `file-upload-chunk`、`attachment-asset-data`、`terminal-snapshot-result`）。
  该 lane 是可选优化；未 OPEN 或能力缺失时所有帧继续走 `zterm`，不改变
  既有单通道行为。
本决策只处理物理 DataChannel 车道拆分与车道级发送流控，不改变 traversal tier
优先级、daemon mirror truth、renderer 策略、后台电源策略或 remote-window 预算。
## 唯一 owner 与归属
- 车道标签、能力协商与单车道分类：`packages/shared/src/connection/protocol.ts`
  （`TERMINAL_MUX_BULK_CHANNEL_LABEL`、`bulkChannel` capability、
  `TERMINAL_MUX_BULK_MESSAGE_TYPES`、`classifyTerminalMuxMessageLane` /
  `classifyTerminalMuxClientFrameLane` / `classifyTerminalMuxServerFrameLane`）。
- 客户端物理车道创建与 lane-aware send/buffered：`packages/shared/src/connection/
  traversal/socket.ts`（`WebRtcBackend` 的 `enableBulkChannel` /
  `bufferedAmountForLane` / `send(data, lane)`）与 `packages/cli/src/connection.ts`
  （`handleMuxReady` 按 capability 打开 bulk lane，`sendFrame` 按分类 lane 发送）。
- Android 原生 DataChannel 车道读数、drain 通知与车道创建：
  `AndroidRtcTransportBackend.java`（`client.connection_service`）。
- Android 服务发送 admission、待发 FIFO、generation fencing、重连分类与 lane
  解析：`AndroidConnectionService.java`（`client.connection_service`）。
- daemon 侧物理车道绑定与车道分类：
  `android/src/server/rtc-bridge.ts`（`attachBulk` / `sendText(text, lane)` /
  `bufferedAmountForLane`）。
- daemon 车道级发送与背压读取：`terminal-transport-runtime.ts`
  （`daemon.transport_subscriber`）；下载 pacing 读 `bufferedAmountForLane('bulk')`，
  水位常量唯一驻留 `terminal-runtime-types.ts`（`daemon.runtime`）。
- buffer-sync 分片预算与续发（phase-1 freeze）：
  `daemon-buffer-publisher-runtime.ts`（`daemon.buffer_publisher`）。
- mux channel / target frame 车道归属：`terminal-channel-mux-runtime.ts` 与
  `terminal-mux-channel-runtime.ts` 按内层消息类型分类，channel 生命周期/关闭
  帧固定走 `control`。
## 车道协商与分类
1. daemon 在 `mux-ready` 的 `capabilities` 中声明
   `bulkChannel: { version: 1, label: 'zterm-bulk' }`；旧 daemon 缺省该字段，
   client 不得假设 bulk lane 存在。
2. client 在 `handleMuxReady` 检测 `capabilities.bulkChannel` 后，对 RTC
   transport 调用 `socket.enableBulkChannel()`（`AndroidRtcTransportBackend
   .createBulkChannel()` / `WebRtcBackend.enableBulkChannel()`）。WebSocket 与
   单通道 daemon 不创建 bulk lane，所有帧继续走 `zterm`。
3. 车道分类必须是唯一真源：`classifyTerminalMuxClientFrameLane` 决定 client
   → daemon；`classifyTerminalMuxServerFrameLane` 决定 daemon → client；
   Java `resolveClientFrameLane` 与 `BULK_LANE_MESSAGE_TYPES` 必须镜像
   `TERMINAL_MUX_BULK_MESSAGE_TYPES`，禁止在 Java/TS 各自维护第二套分类。
4. `mux-channel-binary` 与内层类型在 `TERMINAL_MUX_BULK_MESSAGE_TYPES` 的
   `mux-channel-message` 走 bulk；其余（mux hello、target 控制、channel
   生命周期、reliable input、ACK、请求、file transfer 控制）走 control。
5. mux hello、target 控制事实（`sessions`、`session-activity`、pong、error）、
   `mux-channel-closed` 与 channel open/close 固定走 `control`，禁止随负载压到
   bulk lane。
## 车道级发送与背压
1. `bufferedAmount()`（无参）必须等于 `control` lane + `bulk` lane 的 buffered
   bytes 之和（`AndroidRtcTransportBackend.bufferedAmount()`、`RtcPeerTransport
   .bufferedAmount` 与 `WebRtcBackend.bufferedAmount` 的聚合投影）。
2. lane-aware `bufferedAmount(lane)` 对 bulk 只在 `zterm-bulk` OPEN 时返回 bulk
   值，否则回退 control 值；对 control 恒返回 control 值。bulk 未 OPEN 时 bulk
   帧回退 control 车道，因此背压读数与发送车道必须一致。
3. 高水位 128,000 / 低水位 64,000 仍是发送流控契约（唯一 owner
   `AndroidConnectionService.java`）；背压判定按当前帧实际车道读取，不用控制帧
   值代表负载帧。
4. bulk lane 的 OPEN 是发送前置条件之一；bulk 未 OPEN 时该帧走 control。
   bulk-only close/error 不得触发物理 transport 关闭、ICE 退役或 onClose：
   控制 `zterm` lane 独有物理恢复 ownership，bulk 故障只丢弃 bulk 引用并回退
   control。
5. 禁止半帧跨车道续传：`buffer-sync` 分片一旦开始发送即冻结为一个权威 frame
   identity，后续分片在同一车道按 `nextChunkIndex` 续发；transport generation
   变化或 resync 必须先丢弃 frozen frame、把其 ranges 重新 stage 并从 chunk 0
   重建，禁止把旧车道后半帧接到新车道。
## 图与 resource
- `android-connection-lifecycle.graph.json`：`negotiate_mux` 后新增
  `bind_client_bulk_channel`（`client.connection.bind_bulk_channel`），输出
  `arc.bulk_channel_binding` 再进 `open_session_channels`；`maintain_connection`
  仍消费 `arc.mux_session`。
- `daemon-connection-channel-catalog.graph.json`：`negotiate_mux` 后新增
  `bind_daemon_bulk_channel`（`daemon.connection_gateway.bind_bulk_channel`），
  输出 `arc.bulk_channel_binding` 再进 `register_session_channel`。
- `android-connection-service.graph.json`：`observe_transport_flow` 聚合
  control + bulk 两车道 `nativeBufferedBytes`（含 `controlBufferedBytes` /
  `bulkBufferedBytes` 投影），backpressured 按聚合值判定。
- phase8 `ObserveTransportFlow` 与 phase2 `bind_bulk_channel` 同步注册；
  Phase0/Phase1 gate 沿用项目入口。
## 非目标
不改变有序可靠 DataChannel 属性（ordered、无 maxRetransmits）、traversal tier
优先级、remote-window budget、后台电源策略；不在 MainActivity / Application /
正常启动路径注入测试或诊断逻辑；不 merge / push / release / OTA（Jenny 负责集成）。
