# zterm Session / Transport / Reconnect / Input 路径审计报告

> Superseded on 2026-07-08 for WebSocket lifecycle policy.
> This audit remains historical evidence only. Current truth: a same-session,
> same-target `WebSocket.OPEN` does not expire from quiet time, stale
> `lastServerActivityAt`, missed pong, or pong-only traffic. These signals may
> only trigger same-socket ping / `buffer-head-request` observation; they must
> not close or force-replace the transport. See
> `docs/decisions/2026-04-28-terminal-transport-session-lifecycle-truth.md`,
> `docs/testing/websocket-transport-reuse-test-design.md`, and
> `.agents/skills/terminal-buffer-truth/SKILL.md`.

# zterm Session / Transport / Reconnect / Input 路径审计报告

**日期**: 2026-05-27
**审计人**: Codex
**触发问题**: 切换 tab 后或新增机器连接同一 session 后，原来连接的输入非常卡；杀掉 app 重进秒连且卡顿消失

---

## 一、审计问题

1. zterm 是否支持多输入（多个客户端/session 同时向同一 tmux session 输入）？
2. 为何杀掉 app 重新进入秒连，并且卡顿输入的问题解决了？

## 二、架构总览

### 2.1 输入链路

```
ImeAnchor (Native Android)
 │
 ├─ 'input' event (committed text)
 │    → TerminalPage.emitToActiveSession(sessionId, data)
 │    → terminalInputHandlerRef.current(sessionId, data)
 │    → handleTerminalInput (useTerminalShellActions.ts:69)
 │    → sendInput(sessionId, data) [SessionContext]
 │    → sendInputRuntime (session-context-transfer-runtime.ts:61)
 │    → sendInputThroughSessionTransport (session-context-input-runtime.ts)
 │
 ├─ 'key' event (arrow/enter/esc/tab)
 │    → TerminalPage keyListener
 │    → querySessionInput(sessionId)
 │    → input.dispatchEvent(new KeyboardEvent('keydown', ...))
 │    → createTerminalDomInputController.handleKeyDown
 │    → sendTerminalInput → sendInput
 │
 └─ QuickBar button
      → onSendSequence → handleQuickActionInput
      → sendInput(sessionId, sequence) [bypasses ImeAnchor]
```

### 2.2 Transport 链路

```
sendInput(sessionId, data)
 → sendInputRuntime (session-context-transfer-runtime.ts)
 → sendInputThroughSessionTransport (session-context-input-runtime.ts)
   → readSessionTransportSocket(sessionId) → ws
   → if ws.readyState === OPEN:
       ws.send(JSON.stringify({type:'input', payload}))
   → else:
       stale/open检测 → reconnectSession(sessionId)
```

### 2.3 会话状态机

```
Session lifecycle states:
 closed → connecting → connected ↔ reconnecting → error

Transport lifecycle:
 pending intent → ws.open → handshake → connected
 disconnect → scheduleReconnect → computeReconnectDelay(attempt) → reopen
```

---

## 三、核心常量（来自代码）

| 参数 | 值 | 文件 |
|------|-----|------|
| CLIENT_PING_INTERVAL_MS | 30,000ms | session-context-provider-core-assemblies.ts:24 |
| ACTIVE_TRANSPORT_STALE_ACTIVITY_MS | 35,000ms (PING+5s) | session-context-provider-core-assemblies.ts:25 |
| clientPongTimeoutMs | 70,000ms | session-context-infra-facade-runtime.ts:414 |
| RECONNECT_BASE_DELAY_MS | 1,200ms | session-context-core.ts:25 |
| RECONNECT_MAX_DELAY_MS | 30,000ms | session-context-core.ts:26 |
| computeReconnectDelay(attempt) | min(30000, 1200 × 2^(attempt-1)) | session-context-core.ts:266-268 |
| ACTIVE_HEAD_REFRESH_TICK_MS | 33ms | mobile-config.ts:22 |
| headTickMs (normal) | 66-120ms | mobile-config.ts |
| headStalePingMs | 200-520ms | mobile-config.ts |
| activeTransportProbeWaitMs | 500-1500ms | session-context-provider-facade-assemblies.ts:28-34 |
| staleActivityMs | PING_INTERVAL + 5000 = 35s | isSessionTransportActivityStale |

---

## 四、问题一：是否支持多输入？

### 4.1 Daemon 层（✅ 支持）

daemon 只维护 tmux truth → mirror store。多个 transport 可以并行订阅同一 tmux session。

来自 AGENTS.md:
> daemon 只关心 tmux -> mirror store，不关心也不能关心任何客户端逻辑/状态
> 多个客户端/多个 transport 可以并行订阅同一 tmux mirror

### 4.2 Transport 层（✅ 支持，但有 stale 检测问题）

每个 sessionId 对应独立的 transport socket。多个 sessionId 可以连接到同一个 tmux session。

关键函数 `sendInputThroughSessionTransport` (session-context-input-runtime.ts):
- 只检查 `ws.readyState === OPEN`
- **不检查** sessionId 是否是 activeSessionId
- 只要 transport socket OPEN，就直接发送

**结论**: 从输入路径本身，多客户端输入是支持的。

### 4.3 App 层的 liveSessionIds 管理

`liveSessionIds` 由 `TerminalPage` 的 `renderedPaneSessions` 推导（TerminalPage.tsx:1215-1217）：
- split mode: 各 pane 的 active sessionId
- 单 tab mode: 当前 interactiveSession.id

`onLiveSessionIdsChange` → `setLiveSessionIds` → reducer `SET_LIVE_SESSIONS`（session-context-core.ts:132-144）

**关键**: 只有 liveSessionIds 中的 session 才会被 heartbeat/active-tick 刷新。

不在 liveSessionIds 中的 session：
- transport 依然 OPEN
- 但不发 head request
- `lastServerActivityAt` 不更新（因为 daemon 的 buffer-sync 被 `shouldAcceptSessionLiveBuffer` drop）
- **最终 `isSessionTransportActivityStale` 返回 true**（35s 无新数据）

---

## 五、问题二：杀掉 app 重进为何秒连且卡顿消失

### 5.1 根因分析

**场景**: 用户有两个 tab (A, B)，当前在 A，切到 B 后再切回 A，A 的输入变卡。

**执行链路分析**:

**Step 1: 切到 B 时**

- `liveSessionIds` 更新为 [B.id]
- A 不在 liveSessionIds 中
- A 的 transport 收到 daemon 的 buffer-sync 时：
 - `isSessionTransportActive(A)` = false
 - `shouldAcceptSessionLiveBuffer(A)` = false
 - **buffer-sync 被 drop，不更新 lastServerActivityAt**

**Step 2: 35 秒后**

- `isSessionTransportActivityStale(A)` = true（lastServerActivityAt 35s 前）
- A 的 transport 依然 `ws.readyState === OPEN`

**Step 3: 切回 A 时**

- `activeSessionId` 变为 A.id
- `ensureActiveSessionFresh({source: 'active-reentry', forceHead: true})` 被调用
- `buildActiveSessionRefreshPlan`:
 - `transportStale` = true
 - `wsReadyState` = OPEN
 - `reconnectInFlight` = false
 - **action = 'probe-stale-transport'**
- `probeOrReconnectStaleSessionTransport`:
 - 首次：发送 head request probe，返回 'probed'
 - 如果 probe 在 `activeTransportProbeWaitMs` (500-1500ms) 内没有响应
 - 再次进入：返回 'reconnecting'，触发 `reconnectSession`

**Step 4: reconnect 期间**（1200ms ~ 30000ms）

- transport 被 cleanup
- reconnect timer 等待 `computeReconnectDelay(attempt)` ms
- **期间所有 sendInput 调用**：
 - `ws = null`（已被 cleanup）
 - `pendingTransportOpen` = true
 - **输入被 drop**（session-context-input-runtime.ts:96-115）

**Step 5: 指数退避放大问题**

- 如果 reconnect 失败一次：delay = 1200ms
- 失败两次：delay = 2400ms
- 失败三次：delay = 4800ms
- 最大到 30s

### 5.2 为何杀掉 app 重进秒连

杀掉 app 意味着：
- **所有 React state 重建**
- `reconnectRuntimesRef` = new Map（attempt = 0）
- `lastServerActivityAtRef` = new Map（无 stale 记录）
- `staleTransportProbeAtRef` = new Map（无 probe 历史）
- `manualCloseRef` = new Set
- `createSession` → `connectSession` → `queueConnectTransportOpenIntent`
- **attempt=0 → delay=0 → 立即连接**

**结论**: 杀掉 app 重进绕过了整个 stale 检测 + 指数退避逻辑，直接以 attempt=0 创建新 transport，所以秒连。

### 5.3 卡顿消失的原因

杀掉 app 重进后：
- 新 transport 以 attempt=0 立即创建
- 新 transport 的 `lastServerActivityAt` = 连接成功时的 Date.now()
- `isSessionTransportActivityStale` = false
- `sendInput` 直接走 `ws.send`，不经过任何 stale 检测/探针/reconnect 逻辑

---

## 六、根因定位：stale 检测 + drop input 的联动问题

### 6.1 核心矛盾

**��计意图**: inactive tab 停止接收 buffer-sync 以节省资源 → 35s 后 transport 标记 stale → 切回时 probe/reconnect

**实际问题**:

1. **stale 检测基于 lastServerActivityAt，而非 transport 真实活性**
  - daemon 仍然在推送 buffer-sync
  - 但 `shouldAcceptSessionLiveBuffer` 把它 drop 了
  - 导致 `lastServerActivityAt` 不更新
  - 导致 35s 后 `isSessionTransportActivityStale` = true

2. **probe 期间输入全部被 drop**
  - probe 发送 head request
  - 等待 `activeTransportProbeWaitMs` (500-1500ms)
  - 如果 daemon 不响应（或响应慢），触发 reconnect
  - reconnect 期间 transport cleanup → ws=null → 输入 drop

3. **reconnect 指数退避期间输入全部被 drop**
  - 首次 delay=0 → delay=1200ms → 2400ms → 4800ms → ...
  - 这段时间用户输入全部丢失

### 6.2 关键代码证据

**证据 1**: buffer-sync 被 drop 导致 lastServerActivityAt 不更新

`session-context-transport-runtime.ts:460-470`:
```ts
if (fastMessageType === 'buffer-sync'
   && options.isSessionTransportActive
   && !options.isSessionTransportActive(sessionId)) {
 if (!options.shouldAcceptSessionLiveBuffer?.(sessionId)) {
   return; // ← drop，不调用 recordSessionRx，lastServerActivityAt 不更新
 }
}
```

**证据 2**: recordSessionRx 更新 lastServerActivityAt

`session-context-pull-runtime.ts:70-83`:
```ts
export function recordSessionRx(options: { ... }) {
 options.refs.lastServerActivityAtRef.current.set(options.sessionId, Date.now()); // ← 唯一更新点
 options.refs.staleTransportProbeAtRef.current.delete(options.sessionId);
}
```

**证据 3**: stale 期间 probe 等待 + reconnect 导致输入 drop

`session-context-activity-runtime.ts:40-60`:
```ts
if (probeAgeMs < options.activeTransportProbeWaitMs) {
 return 'waiting'; // ← 500-1500ms 等待
}
reconnectSession(options.sessionId); // ← 等待超时后触发 reconnect
```

**证据 4**: reconnect 期间输入被 drop

`session-context-input-runtime.ts:96-115`:
```ts
const pendingTransportOpen = options.hasPendingSessionTransportOpen(targetSessionId);
if (pendingTransportOpen && !pendingTransportOpenStale && !shouldReconnectNow) {
 return; // ← drop 输入，不排队
}
```

**证据 5**: pendingInputQueueRef 实际不存在

代码中提到 `pendingInputQueueRef` 作为 drop 的补救，但审计发现：
- `sendInputThroughSessionTransport` 只在 `pendingTransportOpen && !stale` 时 drop
- **没有任何地方重新发送 drop 的输入**
- drop 就是丢弃，不是排队

---

## 七、改进建议

### 7.1 短期修复（Critical）

**方案 A: inactive tab 不 drop buffer-sync（推荐）**

修改 `shouldAcceptSessionLiveBuffer`（session-context-transport-orchestration-runtime.ts:226-237）：
- 对于曾是 liveSessionIds 的 session，继续接受 buffer-sync
- 仅停止 head request（节省上行），不停止接收下行 buffer-sync
- 这样 `lastServerActivityAt` 持续更新，不会触发 stale

**方案 B: probe 期间不 drop 输入**

修改 `sendInputThroughSessionTransport`（session-context-input-runtime.ts）：
- 当 `transportStale` 但 `ws.readyState === OPEN` 时：
 - 先发送输入（即使 transport 可能已 stale）
 - 同时触发 probe/reconnect
 - 不要因为 stale 就 drop 输入

**方案 C: reconnect 成功后，重放被 drop 的输入**

引入真正的 `pendingInputQueueRef`：
- 当输入被 drop 时，存入队列
- reconnect 成功后，立即重放队列中的输入
- 设置队列上限（如 1000 字符）和 TTL（如 10s）

### 7.2 中期优化

1. **stale 检测改用 pong 时间**
  - heartbeat 每 30s 发一次 ping，70s 超时
  - 用 `lastPongAt` 替代 `lastServerActivityAt` 作为 stale 依据
  - 即使 buffer-sync 被 drop，pong 仍然会被接收（pong 在 handleSocketServerMessage 中单独处理）

2. **reconnect 指数退避上限降低**
  - 当前最大 30s → 改为 5s
  - 首次 reconnect delay=0（立即重连）

3. **active-tick probe 优化**
  - 切回 tab 时，如果 transport OPEN 且 stale：
    - 先发送输入（乐观策略）
    - 同时发 probe
    - probe 超时才 reconnect

### 7.3 长期架构

1. **transport 和 session 完全解耦**
  - 当前 sessionId 同时标识 transport 和 session
  - 应该 transport-id 和 session-id 分离
  - 允许多个 transport 到同一 session

2. **daemon 推送 vs 客户端拉取**
  - 当前是混合模式：daemon 主推 buffer-sync，客户端定期拉 head
  - 建议统一为 daemon 主推，客户端只在 reconnect 后拉一次 head

---

## 八、验证方案

### 8.1 复现步骤

1. 打开 session A
2. 切换到 session B（或新建 session B）
3. 等待 40s+（确保 A 变 stale）
4. 切回 session A
5. 立即输入 → **预期：输入卡顿或丢失**

### 8.2 验证指标

debug overlay 中检查：
- A 的 `lastServerActivityAt` 时间
- A 的 `transportStale` 状态
- A 的 `reconnectAttempt` 计数
- A 的 `ws.readyState`

### 8.3 adb logcat 检查

```bash
adb logcat | grep "session.input\|session.transport\|session.reconnect"
```

预期日志序列：
1. `session.transport.active-reentry.probe`（切回时）
2. `session.transport.active-reentry.reconnect-after-probe`（probe 超时后）
3. `session.input.drop.pending-transport-open`（reconnect 期间的输入被 drop）

---

## 九、总结

| 问题 | 答案 |
|------|------|
| 是否支持多输入？ | ✅ daemon/transport 层支持；⚠️ app 层因 stale 检测有 bug |
| 为何杀掉 app 重进秒连？ | 绕过 stale+reconnect 指数退避，attempt=0 立即连接 |
| 为何卡顿消失？ | 新 transport 无 stale 标记，输入直发无 drop |
| 根因 | inactive tab 的 buffer-sync 被 drop → lastServerActivityAt 不更新 → stale 误判 → probe/reconnect 期间输入全部丢失 |
| 唯一修复点 | 方案 A（不 drop inactive tab 的 buffer-sync）或 方案 B（stale 期间乐观发送输入） |

---

## 十、相关文件索引

| 文件 | 职责 |
|------|------|
| session-context-input-runtime.ts | sendInput 核心路径 |
| session-context-transfer-runtime.ts | sendInputRuntime 包装 |
| session-context-session-runtime.ts | reconnect 调度、指数退避 |
| session-context-activity-runtime.ts | stale probe + active refresh |
| session-context-lifecycle.ts | foreground/background、active tick |
| session-context-transport-runtime.ts | ws.onmessage、buffer-sync 接收 |
| session-context-socket-runtime.ts | heartbeat、pong 超时 |
| session-context-pull-runtime.ts | recordSessionRx、lastServerActivityAt 更新 |
| session-context-provider-core-assemblies.ts | 常量定义 |
| session-reconnect-helpers.ts | shouldAutoReconnectSession |
| session-transport-open-helpers.ts | refresh plan 构建 |
| TerminalPage.tsx | activeSessionIdRef、liveSessionIds 推导 |
| useTerminalPageInteractionRuntime.ts | interactiveSession 推导 |
| useTerminalShellActions.ts | handleTerminalInput |

# zterm Session / Transport / Reconnect / Input 路径审计报告

**日期**: 2026-05-27
**审计人**: Codex
**版本**: 0.1.1.1702
**触发问题**: 切换 tab 后或新增机器连接同一 session 后，原来连接的输入非常卡；杀掉 app 重进秒连且卡顿消失

---

## 一、审计问题

1. zterm 是否支持多输入（多个客户端/session 同时向同一 tmux session 输入）？
2. 为何杀掉 app 重新进入秒连，并且卡顿输入的问题解决了？
3. 哪些 timeout 没有锚点（anchor）？
4. tab 切换 / 多 app 接入场景应如何主动处理？

---

## 二、架构总览

### 2.1 输入全链路

```text
ImeAnchor (Native Android Capacitor Plugin)
  │
  ├─ 'input' event (committed text, 如中文拼音提交)
  │    → TerminalPage.emitToActiveSession(sessionId, data)
  │    → terminalInputHandlerRef.current(sessionId, data)
  │    → handleTerminalInput [hooks/useTerminalShellActions.ts:69]
  │    → sendInput(sessionId, data) [SessionContext facade]
  │    → sendInputRuntime [session-context-transfer-runtime.ts:61]
  │    → sendInputThroughSessionTransport [session-context-input-runtime.ts]
  │       → readSessionTransportSocket(sessionId) → ws
  │       → ws.send(JSON.stringify({type:'input', payload: data}))
  │
  ├─ 'key' event (arrow/enter/esc/tab from native IME)
  │    → TerminalPage keyListener (session-context-1755)
  │    → querySessionInput(sessionId) → textarea ref
  │    → input.dispatchEvent(new KeyboardEvent('keydown', ...))
  │    → createTerminalDomInputController.handleKeyDown
  │    → sendTerminalInput → sendInput (same path)
  │
  └─ QuickBar button (bypasses ImeAnchor entirely)
       → onSendSequence → handleQuickActionInput
       → sendInput(sessionId, sequence)
```

### 2.2 Transport 生命周期

```text
1. connectSession → cleanupSocket → queueConnectTransportOpenIntent
2. openSessionTransportByIntent → buildTraversalSocketForHost → new WebSocket
3. ws.onopen → handshake (send config/hostConfig) → onConnected
4. startSocketHeartbeat (ping/pong every 30s, 70s timeout)
5. ws.onmessage → recordSessionRx → handleSocketServerMessage
     └─ 'buffer-sync' → applyIncomingBufferSync → commitSessionBufferUpdate
     └─ 'pong' → lastPongAt = now
     └─ 'closed' → finalizeFailure → scheduleReconnect
6. On disconnect: cleanupSocket → scheduleReconnect → startReconnectAttempt
7. Reconnect: computeReconnectDelay(attempt) → setTimeout → queueReconnectTransportOpenIntent
```

### 2.3 Session 状态机

```text
Session lifecycle states:
  closed → connecting → connected ↔ reconnecting → error
                                      ↓ (backoff exhausted)
                                    idle
```

---

## 三、关键常量

| 参数 | 值 | 定义位置 |
|------|-----|----------|
| CLIENT_PING_INTERVAL_MS | 30,000 ms | session-context-provider-core-assemblies.ts:24 |
| ACTIVE_TRANSPORT_STALE_ACTIVITY_MS | 35,000 ms (PING+5s) | session-context-provider-core-assemblies.ts:25 |
| clientPongTimeoutMs | 70,000 ms | session-context-infra-facade-runtime.ts:414 |
| RECONNECT_BASE_DELAY_MS | 1,200 ms | session-context-core.ts:25 |
| RECONNECT_MAX_DELAY_MS | 30,000 ms | session-context-core.ts:26 |
| computeReconnectDelay(attempt) | min(30000, 1200 × 2^(attempt-1)) | session-context-core.ts:266-268 |
| ACTIVE_HEAD_REFRESH_TICK_MS | 33 ms | mobile-config.ts:22 |
| headTickMs (normal profile) | 66–120 ms | mobile-config.ts:66-109 |
| headStalePingMs | 200–520 ms | mobile-config.ts:68-111 |
| activeTransportProbeWaitMs | 500–1500 ms | session-context-provider-facade-assemblies.ts:28-34 |
| sessionHandshakeTimeoutMs | configurable | transport-orchestration-runtime |
| renderCommitMs | 33 ms (via ACTIVE_HEAD_REFRESH_TICK_MS) | mobile-config.ts:33 |

---

## 四、Timeout 盘点：有锚点 vs 无锚点

### 锚点定义
**锚点 = timeout 存在明确的取消条件 / 目标事件 / 上限，不是傻等固定时长。**
有锚点的 timeout：heartbeat ping/pong（pong 到了取消 timeout）、session handshake timeout（handshake 成功取消）、render gate（数据变更时覆盖 timer）。
无锚点的 timeout：reconnect 指数退避（固定 delay 后盲目重连）、activeTransportProbeWaitMs（固定等待窗口无中途取消）。

### 4.1 有锚点的 timeout（✅ 安全）

| timeout | 锚点机制 | 文件 |
|---------|----------|------|
| heartbeat setInterval (30s ping) | ws.onclose 时 clearInterval | session-context-socket-runtime.ts:84 |
| pong timeout (70s) | 每次收到 pong 时 resetPongTimeout → clearTimeout + 重建 | TransportManager.ts:213 |
| session handshake timeout | onConnected 回调 clearSessionHandshakeTimeout | session-context-transport-runtime.ts:415-420 |
| render gate setTimeout | scheduleFlush 时如果已 scheduled 则跳过，dirty=true 时重建 | session-render-gate.ts:288-297 |
| active tick setTimeout | cancelled flag + scheduleNext 递归调用，每轮检查前台状态 | session-context-lifecycle.ts:205-226 |
| debug metrics setInterval | provider dispose 时 clearInterval | session-context-lifecycle.ts:133 |

### 4.2 无锚点的 timeout（⚠️ 有问题）

| timeout | 问题 | 文件:行号 |
|---------|------|-----------|
| **reconnect 指数退避** | `computeReconnectDelay(attempt)` = min(30s, 1200 × 2^(attempt-1))。最长等 30 秒。期间没有"检查 ws 是否已恢复"的锚点，也没有"用户正在输入则跳过 backoff"的中断机制。 | session-context-session-runtime.ts:498 |
| **activeTransportProbeWaitMs** | 固定等 500–1500ms。期间 ws 可能已恢复但探针还没超时，不会主动触发任何动作。没有"ws 收到新数据则立即结束等待"的锚点。 | session-context-activity-runtime.ts:40-53 |
| **ensureSessionReadyForTransfer** | 等待 session ready 的轮询 loop，每 120ms 检查一次，有 timeoutMs 上限。但 timeoutMs 是硬编码参数，没有"transport 状态变化立即唤醒"的锚点。 | session-context-input-runtime.ts:170 |
| **session connect 的 ws.onopen** | 如果 WebSocket 不触发 onopen（如 daemon 不可达），没有显式 timeout → 挂在 handshake timeout 上。但如果 handshake timeout 也过期，错误传播路径较长。 | session-context-transport-runtime.ts:404-420 |

### 4.3 无锚点的复合效应

最危险的组合是 **reconnect backoff × input drop**：

```text
1. tab 切换 → 35s 后 stale
2. probe 等待 activeTransportProbeWaitMs (500-1500ms) — 无锚点
3. probe 超时 → reconnectSession → transport cleanup → ws=null
4. reconnect setTimeout(computeReconnectDelay(0)) = 0ms — 第一次还行
5. 但 reconnect 失败 → setTimeout(computeReconnectDelay(1)) = 1200ms
6. 仍然失败 → 2400ms → 4800ms → ... → 30000ms — 全部无锚点
7. 期间 sendInput → ws=null → pendingTransportOpen=true → DROP（不排队）
```

**30 秒内用户的所有输入全部丢失，且没有任何机制中断这个退避。**

---

## 五、问题一：是否支持多输入？

### 5.1 Daemon 层（✅ 支持）

daemon 只维护 tmux truth → mirror store。多个 transport 可以并行订阅同一 tmux session。

> 来自 AGENTS.md: daemon 只关心 tmux → mirror store，不关心也不能关心任何客户��逻辑/状态。

### 5.2 Transport 层（✅ 支持）

每个 sessionId 对应独立的 transport socket。多个 sessionId 可以连接到同一个 tmux session。

`sendInputThroughSessionTransport` 只检查：
- `ws.readyState === WebSocket.OPEN`
- **不检查** sessionId 是否是 activeSessionId

### 5.3 App 层（⚠️ 有条件支持）

`liveSessionIds` 由 `TerminalPage.renderedPaneSessions` 推导：
- split mode: 各 pane 的 active sessionId
- 单 tab mode: 当前 interactiveSession.id

`onLiveSessionIdsChange → setLiveSessionIds → reducer SET_LIVE_SESSIONS`

**只有 liveSessionIds 中的 session 才会被 heartbeat/active-tick 刷新 head。**
不在 liveSessionIds 中的 session：transport 依然 OPEN，但不发 head request，daemon 的 buffer-sync 被 `shouldAcceptSessionLiveBuffer` drop，`lastServerActivityAt` 不更新。

**结论**: daemon/transport 层天然支持多输入；app 层因为 stale 检测 bug，inactive tab 的 transport 会被误判为 stale，导致切回时输入丢失。

---

## 六、问题二：杀掉 app 为何秒连且卡顿消失

### 6.1 复现路径（根因链路）

```text
1. 打开 session A，正常输入
2. 切到 session B
   → liveSessionIds = [B.id]（A 不在其中）
   → A 的 heartbeat tick 仍在运行（shouldScheduleActiveTickRefresh 检查 activeSessionId + liveSessionIds）
   → 但 A 的 ws.onmessage 收到 daemon 的 buffer-sync 时：
      isSessionTransportActive(A) = false（A 不在 activeSessionId 也不在 liveSessionIds）
      → shouldAcceptSessionLiveBuffer(A) = false
      → buffer-sync 被 drop，不调用 recordSessionRx
      → lastServerActivityAt 不更新

3. 35 秒后（ACTIVE_TRANSPORT_STALE_ACTIVITY_MS）
   → isSessionTransportActivityStale(A) = true
   → 但 ws.readyState 仍然 === WebSocket.OPEN（daemon 并未断开连接）

4. 切回 A
   → activeSessionId = A.id
   → ensureActiveSessionFresh({source: 'active-reentry', forceHead: true})
   → buildActiveSessionRefreshPlan: transportStale=true, wsReadyState=OPEN, reconnectInFlight=false
   → action = 'probe-stale-transport'
   → probeOrReconnectStaleSessionTransport: 首次发送 head request probe，返回 'probed'

5. probe 等待 activeTransportProbeWaitMs (500-1500ms) — 无锚点傻等
   → 如果 daemon 不在预期时间响应：返回 'reconnecting'
   → reconnectSession(A) → cleanupSocket(A, false) → ws=null → transport 标记为 reconnecting

6. scheduleReconnect → startReconnectAttempt:
   → computeReconnectDelay(0) = 0ms → 立即尝试第一次
   → 如果第一次失败：computeReconnectDelay(1) = 1200ms
   → 仍然失败：2400ms → 4800ms → 9600ms → 19200ms → 30000ms（最大值）

7. 期间所有 sendInput(A, data) 调用：
   → ws = readSessionTransportSocket(A) = null（已被 cleanup）
   → pendingTransportOpen = true
   → pendingTransportOpenStale = false（刚创建的 intent 还没超时）
   → shouldReconnectNow = false（因为 intent 不 stale）
   → **直接 return，输入被 drop，不排队**

8. 用户感知：切回 A 后输入 1-30 秒无响应（取决于 reconnect 成功时机）
```

### 6.2 杀掉 app 重���为何秒连

杀掉 app 意味着：
- 所有 React state 重建
- reconnectRuntimesRef = new Map（attempt = 0）
- lastServerActivityAtRef = new Map（无 stale 记录）
- staleTransportProbeAtRef = new Map（无 probe 历史）
- manualCloseRef = new Set
- createSession → connectSession → queueConnectTransportOpenIntent
- attempt=0 → delay=0 → 立即建立新 WebSocket → 立即握手

**结论**: 杀掉 app 绕过了整个 stale 检测 + 指数退避逻辑，直接以 attempt=0 创建新 transport，所以秒连。

### 6.3 卡顿消失的原因

新 transport 的 `lastServerActivityAt` = 连接成功时的 Date.now()
→ `isSessionTransportActivityStale` = false
→ `sendInput` 直接走 `ws.send`，不经过任何 stale/probe/reconnect 逻辑

---

## 七、根因总结

### 核心矛盾

**设计意图**: inactive tab 停止接收 buffer-sync 以节省资源 → 35s 后 transport 标记 stale → 切回时 probe/reconnect

**实际问题**:
1. **stale 检测基于 lastServerActivityAt，而非 transport 真实活性** — daemon 仍在推送 buffer-sync，但被 `shouldAcceptSessionLiveBuffer` drop，导致 lastServerActivityAt 不更新，35s 后误判 stale
2. **probe 等待 + reconnect 期间输入全部被 drop** — sendInputThroughSessionTransport 中 pendingTransportOpen + !stale 的分支直接 return，不排队
3. **reconnect 指数退避期间输入全部被 drop** — 最长 30s，无中断机制

### 关键代码证据

**E1**: buffer-sync 被 drop → lastServerActivityAt 不更新
> `session-context-transport-runtime.ts:460-470`: fastMessageType === 'buffer-sync' && !isSessionTransportActive → !shouldAcceptSessionLiveBuffer → return (不调用 recordSessionRx)

**E2**: recordSessionRx 是 lastServerActivityAt 的唯一更新点
> `session-context-pull-runtime.ts:77-78`: lastServerActivityAtRef.current.set(sessionId, Date.now())

**E3**: probe 等待期间无中断机制
> `session-context-activity-runtime.ts:40-53`: probeAgeMs < activeTransportProbeWaitMs → return 'waiting'（无锚点）

**E4**: probe 超时后触发 reconnect → transport cleanup
> `session-context-activity-runtime.ts:55-57`: probeAgeMs >= activeTransportProbeWaitMs → reconnectSession → cleanupSocket

**E5**: reconnect 期间输入被 drop（不排队）
> `session-context-input-runtime.ts:96-115`: pendingTransportOpen && !stale → return（不调用 reconnectSession，也不排队）

---

## 八、改进方案（两大原则）

### 原则 1: 所有 timeout 必须有锚点

#### 改动 A: reconnect backoff 加入用户输入锚点

当用户正在输入时，如果 reconnect 指数退避还没到期，**立即中断退避**。

```typescript
// session-context-input-runtime.ts - sendInputThroughSessionTransport
if (shouldReconnectNow) {
  // 原有逻辑：reconnectSession(targetSessionId)
  // 新增：如果 reconnect 在 backoff 中，立即中断 backoff
  options.forceImmediateReconnect(targetSessionId); // 新接口
}
```

`forceImmediateReconnect` 实现：
```typescript
// session-context-session-runtime.ts - startReconnectAttemptRuntime
function forceImmediateReconnect(sessionId: string) {
  const reconnectRuntime = reconnectRuntimesRef.get(sessionId);
  if (reconnectRuntime?.timer) {
    clearTimeout(reconnectRuntime.timer);
    reconnectRuntime.timer = null;
    reconnectRuntime.nextDelayMs = 0; // 立即重连
    reconnectRuntime.attempt = 0;      // 重置退避
    startReconnectAttempt(sessionId);   // 触发立即重连
  }
}
```

#### 改动 B: activeTransportProbeWaitMs 加入数据锚点

probe 等待期间，如果 ws 收到任何数据（说明 transport 实际没 stale），立即结束等待。

```typescript
// session-context-activity-runtime.ts - probeOrReconnectStaleSessionTransportRuntime
const probeAgeMs = Date.now() - lastProbeAt;
// 新增：如果 lastServerActivityAt 在 probe 之后更新了，说明 transport 已恢复
if (lastActivityAt > lastProbeAt) {
  // transport 有新数据，不需要 reconnect
  return 'recovered' as const;
}
```

### 原则 2: tab 切换 / 多 app 接入要主动处理

#### 改动 C: shouldAcceptSessionLiveBuffer 对曾活跃 session 放行 buffer-sync

**核心修复**：inactive tab 不再 drop buffer-sync，仅停止 head request（上行）。

```typescript
// session-context-transport-orchestration-runtime.ts - shouldAcceptSessionLiveBuffer
shouldAcceptSessionLiveBuffer: (sessionId: string) => {
  // 原逻辑：仅检查 activeSessionId / liveSessionIds
  // 新增：检查 session 是否曾经连接成功过（hasLocalWindow）
  const session = stateRef.current.sessions.find(c => c.id === sessionId);
  if (!session) return false;
  // 曾连接过的 session，继续接受 buffer-sync
  return session.state === 'connected' || session.state === 'reconnecting';
}
```

**效果**：
- inactive tab 的 `lastServerActivityAt` 持续更新
- `isSessionTransportActivityStale` 不会误判为 true
- 切回时不需要 probe/reconnect，直接发送 head request 刷新数据

#### 改动 D: input drop 改为 input queue（有界队列）

如果改动 C 被采用，大多数情况下不会触发 input drop。但仍需防护极端场景（如网络中断）。

```typescript
// session-context-input-runtime.ts - sendInputThroughSessionTransport
if (pendingTransportOpen && !pendingTransportOpenStale && !shouldReconnectNow) {
  // 原逻辑：直接 return（drop）
  // 新增：排队等待
  if (options.inputQueueSize(sessionId) < MAX_QUEUED_INPUT_SIZE) {
    options.enqueueInput(sessionId, options.data);
    return;
  }
  // 队列满：drop + debug log
  options.runtimeDebug('session.input.drop.queue-full', { ... });
  return;
}
```

#### 改动 E: reconnect backoff 上限降低

```typescript
// session-context-core.ts
const RECONNECT_MAX_DELAY_MS = 30000; // 现有值
// 建议修改为
const RECONNECT_MAX_DELAY_MS = 5000;  // 最大 5 秒
```

---

## 九、验证方案

### 9.1 复现步骤

1. 打开 session A，正常输入
2. 切换到 session B（或新建 session B）
3. 等待 40s+（确保 A 变 stale）
4. 切回 session A
5. 立即输入 → **预期：输入卡顿或丢失**

### 9.2 验证指标

debug overlay 检查：
- A 的 `lastServerActivityAt` 时间（不应停止更新）
- A 的 `transportStale` 状态（改动 C 后应始终为 false）
- A 的 `reconnectAttempt` 计数（改动 C 后应为 0）
- A 的 `ws.readyState`（应始终为 OPEN）

### 9.3 adb logcat 检查

```bash
adb logcat | grep "session.input\|session.transport\|session.reconnect\|buffer-sync.preparse"
```

改动前预期日志：
```text
session.transport.active-reentry.probe           // 切回时
session.transport.active-reentry.reconnect-after-probe  // probe 超时
session.input.drop.pending-transport-open        // 输入被 drop
```

改动后预期日志（改动 C）：
```text
session.transport.active-reentry.request-head    // 直接拉 head，不需要 probe
session.input.send                               // 输入直接发送成功
```

---

## 十、总结

| 问题 | 答案 |
|------|------|
| 是否支持多输入？ | ✅ daemon/transport 层支持；⚠️ app 层因 stale 误判有 bug |
| 为何杀掉 app 重进秒连？ | 绕过 stale+reconnect backoff，attempt=0 立即连接 |
| 为何卡顿消失？ | 新 transport 无 stale 标记，输入直发无 drop |
| 根因 | shouldAcceptSessionLiveBuffer drop inactive tab 的 buffer-sync → lastServerActivityAt 不更新 → stale 误判 → probe/reconnect 期间输入全部丢失 |
| 无锚点 timeout | reconnect backoff（最长 30s）、activeTransportProbeWaitMs（500-1500ms）、ensureSessionReadyForTransfer（120ms 轮询） |
| 推荐修复 | 改动 C（shouldAcceptSessionLiveBuffer 放行）+ 改动 A（backoff 加锚点）+ 改动 E（backoff 上限降低） |
| 唯一真源修改点 | session-context-transport-orchestration-runtime.ts 的 shouldAcceptSessionLiveBuffer 回调 |


## 十一、2026-05-27 本轮已落地修复

### 已实现 1：probe wait 增加 activity anchor

修改点：`android/src/contexts/session-context-activity-runtime.ts`

现在 `probeOrReconnectStaleSessionTransportRuntime(...)` 在进入 wait / reconnect 之前，先检查：

```ts
if (lastProbeAt > 0 && lastActivityAt > lastProbeAt) {
  return 'recovered'
}
```

含义：
- 只要 probe 发出后 transport 已经收到新的 server activity
- 就说明旧 transport 仍然活着
- 不再继续傻等 `activeTransportProbeWaitMs`
- 也不再误触发 reconnect

这满足 Jason 的规则：timeout 必须有锚点，不能固定傻等。

### 已实现 2：stale-open explicit input 改为主动 probe

修改点：`android/src/contexts/session-context-input-runtime.ts`

现在 explicit input 在 `ws.readyState === OPEN && transportStale === true` 时：
1. 仍然先发送 input
2. 立刻调用 `probeOrReconnectStaleSessionTransport(sessionId, ws, 'input')`

含义：
- 输入本身变成 transport 健康检查锚点
- 不再被动等 lifecycle tick / foreground tick 才处理 stale-open transport
- tab 切换 / 多 app 接入时，用户第一拍输入就会主动推进 transport 真相收敛

这满足 Jason 的第二条规则：指定场景要主动处理，不能被动等待。

### 本轮验证证据

1. 红测先失败后转绿：
   - `src/contexts/session-context-activity-runtime.test.ts`
   - `src/contexts/session-context-input-runtime.test.ts`
2. 目标回归：
   - `5 files / 151 tests passed`
3. type-check：
   - `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` 通过
4. daemon 实测：
   - `pnpm run daemon:mirror:close-loop` 全绿
   - 包含：`codex-live / top-live / vim-live / initial-sync / local-input-echo / external-input-echo / daemon-restart-recover / schedule-fire`

### 当前仍未落地的后续项

本轮只修了“有锚点等待 + stale-open 主动 probe”这两个唯一真源点；以下仍是后续项：
1. reconnect backoff 被用户输入主动打断（force immediate reconnect）
2. inactive tab 是否继续放行 buffer-sync，避免 `lastServerActivityAt` 误 stale
3. pending transport open 期间 input 是否改为 bounded queue 而不是 drop
