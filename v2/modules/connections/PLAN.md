# connections 首增量 plan

合同：zterm-v2-connections-impl-1103。目标：公开 connect/openChannel/observeLink/closeOwnLink，LAN 两机真实正反例，记录实际路径，不伪造在线。

## 图（最小正确图）

单输入 arc.connect_request（machineId+verifiedAuthorization）→ resolve_authorized_candidates（授权解析，凭据不进入 payload）→ filter_supported_capabilities（能力筛选）→ establish_handshake（V1 traversal/app 候选实际握手+对端验证）→ negotiate_channel（channel kind 能力）→ emit_link_result（LinkRef + {path,status,freshness}）。成功、拒绝、失败、unknown 汇入同一结果出口 arc.connect_result。

恢复操作是单独入口（closeOwnLink/observeLink），不画无限回边。长期链路生命周期不伪装 SESE。

## 实现分层

- public/link-port：connect/openChannel/observeLink/closeOwnLink 类型与工厂。公开类型：LinkRef、ChannelRef、LinkObservation、LinkStatus、LinkPath、Capabilities、ConnectAuthorization。
- domain/link-state：身份、代次、能力、路径与 freshness 推导；禁止把授权 token 当状态。
- application/connection-manager：候选到连接的编排，按目标 machineId/daemonHostId 校验身份，V1 traversal 候选计划与 route selector 消费；记录实际选中路径（来自 TraversalSocket getDiagnostics().resolvedPath，绝不从目录端点推断）。
- adapters/v1-traversal：V1 公开 traversal buildTraversalPlan/selectBestTraversalRoute 的只读复用边界，不做第二套排序。
- adapters/app-websocket：V1 /app 显式兼容通道，Bearer 与 app-hello/app-ready 握手；复用 app-protocol 验证帧，不复制消息状态机。
- channels/dispatch：kind 能力协商；app 支持，terminal-mux 与 file 返回 UNSUPPORTED_CHANNEL（首增量不宣称已支持）。
- ports/transport：平台传输契约（createWebSocket、timers 注入）；不写凭据。

## 红测优先

先写 tests/contract/link-port.contract.test.ts 正反例（错误身份、空/错 token、不可达、unsupported channel、旧代不覆盖、状态查询），红测失败证据落 v2/evidence。然后实现，再跑真实黑盒。

## 验收

- 正例：connect 本机/局域网 daemon，observeLink path=实际选中、status=connected、freshness=fresh；openChannel(app) 发送 app-ping 收到 app-pong；两个 channel 一个 close 另一个继续。
- 反例：身份/凭据/目录拒绝不换通道；不可达不报 connected；unsupported channel 显式拒绝。
- 黑盒：真实 daemon /app（V1 已运行），不 mock。

## 资源

- 写入：v2/modules/connections/{DESIGN.md,src,tests}、v2/evidence/zterm-v2-connections-impl-1103。
- 不改 V1 与 shared 源码；不 publish；不 push。

## R3 返工（真实 channel 适配）

按 David R3 三项 channel finding 修改。目标：不再把 terminal mux 传输能力冒充业务通道，补真实远端 open/ack 与真实 V1 daemon consumer 证据。

### 改动

1. `LinkKind` 增加 `terminal`；`ChannelOpenRequest`/`TerminalChannelTarget` 承载真实 target（sessionName/backend/expectedSessionIdentity/existingOnly/bodySubscribed）。
2. `TransportHandle` 增加 `openChannel(request): Promise<ChannelOpenResult>` 与 `closeChannel(channelId, reason?)`；channel 只有在 open 成功后才可 send。
3. `V1TraversalTransport`：`deriveChannelKinds` 只把 `channelEnvelope` 映射为 `terminal`；`openChannel` 发 `mux-channel-open` 并等 `mux-channel-opened`/`mux-channel-closed`/`mux-error`；未接 generic message/file 显式 `unsupported_channel`。
4. 真实 bridge 错误 token 返回 `{type:"error",payload:{code:"unauthorized"}}` 后 4001；按真实帧分类为 `unauthorized`。
5. `mux-ready` 省略 `daemonHostId` 时使用 accounts 已验证身份（token 保护端点刚完成握手）。

### 红测证据

- `tests/integration/real-entry.test.ts`：真实 `ws` 服务器只回 `mux-ready`（无 daemonHostId、capabilities 无 generic message/file）；断言 capabilities 只含 `terminal`，`message/file/receipt/status` 均 `unsupported_channel`；`mux-channel-open` 必须等 `mux-channel-opened`，拒绝会话 target 返回 `link_closed` 且 link 保持 connected。红测在未改 adapter 时失败（旧 deriveChannelKinds 断言 `["message","file"]` 且 open 返回非 Promise）。
- 红测日志：`v2/evidence/zterm-v2-connections-impl-1103/rework/red-vitest.log`（旧 6 failed / 17 passed）。

### 黑盒（真实 V1 daemon）

- `tests/integration/real-daemon.test.ts`（默认 skip，设置 `ZTERM_REAL_DAEMON=1` 启用）对运行中的真实 daemon `192.168.0.3:3333`：
  - 握手连接成功，`observeLink.status=connected`、`path=direct`、`capabilities.channelKinds=["terminal"]`；
  - `message/file/receipt/status` 均 `unsupported_channel`；
  - `mux-channel-open`（exact existing：真实 `list-sessions` 取 `zterm-1` stableId，`expectedSessionIdentity`+`backend=tmux`+`existingOnly=true`+`bodySubscribed=false`）真实得到 `mux-channel-opened`，close 后 link 仍 connected；
  - 错误 token 分类为 `unauthorized`。
- 日志：`v2/evidence/zterm-v2-connections-impl-1103/rework/real-daemon-vitest.log`（3 passed）。
- 注意：真实 open 为 `bodySubscribed=false` 且不传 cols/rows，因此只读 attach，不写共享 tmux 几何、不订阅正文。

### 结果

- `pnpm test`：27 passed（contract 18 + real-entry 9）；real-daemon 3 passed；`tsc --noEmit` exit 0。
- 真实两机 LAN 仍为下一增量；本 R3 用同一真实 V1 daemon 的 mux 握手/open/ack 与 unsupported 证据，不是回环 echo。两机独立机器贯通仍未验收，交 Jenny 集成时明确。
