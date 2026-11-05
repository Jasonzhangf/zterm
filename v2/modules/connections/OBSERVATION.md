# connections 首增量 observation

任务：zterm-v2-connections-impl-1103（独占 GCM worker，Jenny 派，Reviewer David，集成 Jenny）。
日期：2026-11-03。

## 目标语义

公开契约：connect(machineId, verifiedAuthorization) -> LinkRef；openChannel(LinkRef, kind) -> ChannelRef；observeLink(LinkRef) -> { path, status, freshness }；closeOwnLink(LinkRef)。

本增量只实现 LAN 两机真实授权握手和正反例，记录实际选中路径（direct/relay），不把未连接报成 connected。跨网 direct/relay 与 /app 数据投递在下一增量。

## 受影响现有图

- V1 已有 daemon-app-messaging.graph.json：单输入 arc.request → extract → validate → resolve_route → admit_connection → prepare → execute → publish → settle → arc.app_result。拓扑闭合、单输入单输出。它绑定的是 V1 CLI/daemon app operator，不是 V2 公开 connect/openChannel/observeLink 的新门禁。
- 设计稿 practice-audit §4 明确指出需要新增连接对象流：授权候选 → 能力筛选 → 实际握手/对端验证 → 通道协商 → 明确结果，以及单独的连接恢复操作；一次操作的成功/拒绝/unknown 汇入同一结果出口。长期生命周期不靠回边伪装 SESE。
- 当前 v2/ 没有可执行连接 graph（只有模块 DESIGN 与设计稿）。因此本实现先补最小正确图设计：授权候选 → 能力筛选 → 实际握手/对端验证 → 通道协商 → 明确结果。成功、拒绝、失败、unknown 均汇入同一结果出口。

## 源码事实

### 复用公开 V1 traversal 策略

- packages/shared/src/connection/traversal/policy.ts 定义 DEFAULT_TRAVERSAL_PATH_PRIORITY = lan → ipv6 → ipv4 → rtc-direct → tailscale → rtc-relay。
- packages/shared/src/connection/traversal/config.ts buildTraversalPlan / buildTraversalPlanCached 从 target+settings 构造候选（WebSocket 与 RTC，含 directory endpoint 与 daemon token），不复制第二套排序。
- packages/shared/src/connection/traversal/route-selector.ts selectBestTraversalRoute 是 tier-first：健康/lease 只在同 tier 内排序，不把低 tier 提升到高 tier。
- packages/shared/src/connection/traversal/types.ts 定义 TraversalResolvedPath、AttemptFailure、FailureDecision、TraversalDiagnostics。
- packages/shared/src/connection/traversal/socket.ts TraversalSocket 实现 BridgeTransportSocket，包含 WebSocket/RTC backend、mux-ready 确认（requireOpenConfirmation）、runner-up 回退、reconnect 与 diagnosis；confirmTransportReady 只在上层协议就绪后记录成功。

### /app 兼容通道与鉴权

- 当前 V1 /app 是独立 WebSocket + Bearer：android/src/server/daemon-app-websocket-runtime.ts handleServerUpgrade 校验 bearer token（timingSafeEqual），acceptHello 校验 local 角色 loopback 且身份匹配，peer 角色允许非 loopback 并对远端身份做目录授权；daemon-app-messaging-runtime.ts connectPeer 按 target.wsUrl+authToken 建 WebSocket。
- packages/cli/src/app-connection.ts AppClientConnection.connect 以 Bearer 建 ws，做 app-hello/app-ready 握手，校验 ready 身份等于本机配置，settlement 按 requestId+messageId 绑定，防 stray 帧冒成成功。
- packages/shared/src/connection/app-protocol.ts 是纯协议 owner：APP_PROTOCOL_VERSION=1、AppErrorCode、validateAppClientFrame/validateAppServerFrame、AppCapabilities。
- 设计稿明确：V1 /app 可以是显式兼容通道，不假称已接 terminal mux 或 RTC。

### accounts 授权注入

- 合同禁止直接读取凭据；凭据由 accounts 提供。本实现采用端口注入：ConnectAuthorization 持有 targetMachineId、targetDaemonHostId、endpoints（含 authToken/authRequired）、signalUrl/relay/turn 配置；凭据只在边界 adapter 内进入 V1 候选构造，不进入 ticket payload，不落盘、不打印。
- packages/cli/src/app-target-resolution.ts resolveAppTargetFromDirectory 是 V1 目录→AppTarget 的现有读取入口；resolveAppTarget 先 accountClient.me + directory 再校验 userId。V2 不复制目录请求，改为注入已验证的 directory 授权。

## 首增量边界

允许：v2/modules/connections/**、v2/evidence/zterm-v2-connections-impl-1103/**。禁止：V1、packages/**、android/**、mac/**、win/**、其他 v2/modules/*、daemon/tmux 生命周期、push/PR、全局安装。

实现只新增 connections 模块自己的 TS 源码、测试和证据；不改 V1 或 shared 源码。依赖方向：connections 通过公开类型/函数引用 @zterm/shared 的 traversal/app-protocol（现有 V1 公开 surface），以及注入的 accounts/授权端口。

## 真实入口与验收路径

- 正例：本机 V2 connections 公开入口 connect() 用已验证同账号目录授权，连接本机已运行 daemon 的 /app（loopback local role）或远端 LAN daemon（peer role），返回 LinkRef，observeLink 显示 path=lan 或实际选中路径、status=connected、freshness=fresh；openChannel(kind=app) 返回 ChannelRef 并可发送 app-ping 得到 app-pong；两个 channel 一个关闭不关闭另一个（V1 逻辑分帧隔离语义）。
- 反例：错误身份（daemonHostId 不匹配）拒绝；空/错 token 拒绝；不可达端点不报 connected（返回 unreachable/unknown，不伪造）；不支持能力（channel kind 非 app）显式拒绝。
- LAN 两机真实贯通是当前增量；跨网 direct/relay 与 /app 数据投递留下一增量。

## 缺口

- V2 公开 connect/openChannel/observeLink/closeOwnLink 没有现成实现，只有设计稿。
- V2 没有可执行连接 DAG gate；仅设计稿给出对象流。
- V1 terminal mux 的 bodySubscribed=false 释放冲突不影响本增量（本增量只做 app 兼容通道，不碰 terminal 订阅）。
- RTC direct/relay 数据面与跨网路径未在首增量实现。

## 结论

最小增量：在 v2/modules/connections/src 新增公开 link-port 与 domain/application/adapters/channels 实现，消费 V1 traversal 候选与 app 协议；用 V1 已运行 daemon 的本地/局域网 /app 做真实黑盒正反例。不复制 V1 候选排序，不伪造在线，不写凭据。

## R3 返工（chan nel finding 关闭）

David R3 指出三项未关闭：deriveChannelKinds 把 terminal mux 的 channelEnvelope/bulkChannel 当 generic message/file 服务声明；ChannelDispatcher.open 只造本地地址、无远端 open/ack；send 把任意 payload 写进未注册 terminal mux channel。已按真实 V1 公共协议修正：

- 真实事实：`android/src/server/terminal-mux-channel-runtime.ts` 的 `mux-channel-open` 必须携带真实 `sessionName`（exact-existing 还需 `expectedSessionIdentity`+`backend`），服务端才回 `mux-channel-opened`；`mux-ready.capabilities` 只声明 `channelEnvelope/targetMessages/boundedBodyScheduler`，没有 generic message/file 服务声明。真实 daemon 的 `mux-ready` 还省略 `daemonHostId`。
- 修正：`deriveChannelKinds` 只把 `channelEnvelope` 映射为 `terminal` 会话 channel；`openChannel` 改为 async，terminal open 必须带 target，先发 `mux-channel-open` 等 `mux-channel-opened`；只有 ack 之后才注册 channel 与允许 send；message/file/receipt/status 在 terminal mux 上显式 `unsupported_channel`（它们的真实服务是独立 `/app`，下一增量接入）。
- 身份：`mux-ready.daemonHostId` 存在时不一致则 `peer_identity_mismatch`；缺失时使用 accounts 已验证的授权身份，因为 token 保护端点刚完成 mux 握手。
- 保留 1224316f 的旧代失败栅栏与坏握手资源释放修正。
- 真实反例发现：错误 token 时真实 bridge 先发 `{type:"error",payload:{code:"unauthorized"}}` 再 4001 关闭；适配器已按真实帧分类为 `unauthorized`。
