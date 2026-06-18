# daemon 性能和 Multi-Session 切换审计报告

**审计日期**: 2026-06-18
**审计范围**: `~/.wterm/daemon-runtime/server.cjs` (11054 行) → 对应源码 `android/src/server/`
**前提约束**: AGENTS.md 冻结 daemon 不持有 client 心智；mirror-fixed 模式 daemon 不接受客户端宽度变化

---

## 1. 架构拓扑

```
tmux session(s)
    ↓ capture / canonicalize
daemon mirror (per tmux session, Map<mirrorKey, SessionMirror>)
    ↓ per-subscriber cadence decision
buffer-sync / buffer-head broadcast
    ↓ sendMessage(session, msg)
session transport (per ws/rtc transport, Map<transportId, DaemonTransportConnection>)
    ↓ WebSocket → Android client

client input
    ↓ input wire
writeInputIfCurrent(connection, data)
    ↓ resolveCurrentSessionForInput → session
    ↓ handleInput(session, data, shouldWrite)
    ↓ enqueueLiveMirrorInput(mirrorKey, data, appendEnter=false)
    ↓ queueMicrotask → flushPendingLiveMirrorInput
    ↓ runTmuxAsync(['send-keys', '-t', sessionName, '-l', '--', payload])
```

---

## 2. 性能风险

### 2.1 Mirror Live Sync Cadence — 全局串行 Timer

**现状**:
- `MIRROR_LIVE_SYNC_ACTIVE_MS = 33ms`, `MIRROR_LIVE_SYNC_IDLE_MS = 120ms`
- 每个 mirror 持有一个 `liveSyncTimer` (`setTimeout`)，mirror 数 N → N 个独立 timer
- `resolveMirrorLiveSyncDelay` 对整个 mirror 聚合所有 subscriber 的 backpressure (`Math.max`)
- `broadcastChangedRangesBufferSyncToSubscribers` 对所有 subscriber **同步串行**发 JSON

**风险**:
- mirror 聚合 backpressure 时，"最慢 subscriber" 的 backpressure 会拖累"最快 subscriber"的刷新频率
  - `transportBackpressureCount: Math.max(...allSubscribers.backpressureCount)` — **一个慢的客户端会把所有 subscriber 拖进 slow lane**
  - 即使其他 subscriber 网络很好，也会因为同一个 mirror 内有一个 backpressure client 而被迫降频
- `broadcastChangedRangesBufferSyncToSubscribers` 同步遍历 `mirror.subscribers`，若 subscriber 数多且网络慢，broadcast 可能阻塞后续 capture cycle

**已存在的正确设计**:
- `broadcastChangedRangesBufferSyncToSubscribers` 里用 `resolveMirrorLiveSyncDelayForSubscriber` 做 per-subscriber lane 判断
- backpressure subscriber 被 skip（`continue`）不阻塞其他 subscriber 收到 diff
- `scheduleMirrorLiveSync` 确实对每个 mirror 独立，这是正确的（每个 tmux session 一个 capture cadence）

**未解决的核心矛盾**: mirror-level `transportBackpressureCount` 的 `Math.max` 聚合会导致慢 subscriber 把 mirror-level 刷新降下来（因为 `capture cost * 1.25` 的 overload lane），但 buffer-sync 发送对 backpressure subscriber 已被正确 skip。**实际上风险比预期小**，但 mirror-level overload lane 仍可能被一个极慢 subscriber 触发。

### 2.2 Buffer-Sync 广播 — 同步 JSON Serialize Per Subscriber

**现状**:
```typescript
for (const sessionId of mirror.subscribers) {
  const payload = deps.buildChangedRangesBufferSyncPayload(mirror, changedRanges); // 每个 subscriber 重算？
  // 实际上 buildChangedRangesBufferSyncPayload 是纯函数，mirror.lines 引用共享
  deps.sendMessage(session, { type: 'buffer-sync', payload });
}
```

**风险**: 若 `buildChangedRangesBufferSyncPayload` 不是纯函数引用（可能依赖 mirror 的某个 mutable 状态），多 subscriber 会得到不一致的 payload。但从代码看它是稳定的（mirror.lines 直接引用），风险低。

**真正的风险**: `sendMessage` 内部 `JSON.stringify(message)` + `transport.sendText()` 在 subscriber 数多时是同步串行的。若某 subscriber 的 WebSocket 底层 write buffer 满，`sendText` 会阻塞整个 loop，导致其他 subscriber 收包延迟。

### 2.3 Input Batching — 同 Mirror 并发 Flush 安全

**现状**（已修复，本轮 commit）:
- `liveMirrorInputBatches` 是 `Map<mirrorKey, PendingBatch>`，一个 mirror 一个 batch
- `enqueueLiveMirrorInput` → `schedulePendingLiveMirrorInput` → `queueMicrotask` → `flushPendingLiveMirrorInput`
- flush 内对 `writableItems` 做 `shouldWrite` 过滤后分组，合批发 `tmux send-keys -l`
- 每个 group 内 `await runTmuxAsync` 串行

**风险**: 极低。但存在一个边界：
- `pending.flushing = true` 在 flush 开始时设置，但 `flushPendingLiveMirrorInput` 本身是 `async function`
- 若在 `await runTmuxAsync` 期间 tmux session 被 destroy（mirror lifecycle → 'destroyed'），flush 会继续执行完（因为 `runTmuxAsync` 是同步等待的）
- 这在 mirror 被 destroy 时可能导致 `writeToTmuxSession` 对一个不存在的 tmux session 发 `send-keys`

**已存在防护**: flush 开头检查 `if (!mirror || mirror.lifecycle !== 'ready')`，在 `await` 之间不会重入，但 tmux session 实际消失的情况下 flush 仍会尝试写入。影响小（只会 tmux 报错），但应补 `shouldWrite` 再次检查。

### 2.4 Per-Subscriber Lane Skip — Head 广播不受保护

**现状**:
- `broadcastBufferHeadToSubscribers`（光标/keysApp 变化）**没有** `resolveMirrorLiveSyncDelayForSubscriber` 判断，所有 subscriber 同步收到 head
- `broadcastChangedRangesBufferSyncToSubscribers` 有 backpressure skip 保护

**风险**: head 广播不受 subscriber backpressure 保护。若某 subscriber 网络极慢（bufferedAmount > 128KB），它的慢速会拖累 `sendMessage` 的 `JSON.stringify + sendText` 同步调用，进而影响其他 subscriber 的 head 收包。**低频但存在**。

---

## 3. Multi-Session 切换风险

### 3.1 Tab 切换 — 同一 Transport 多次 Bind

**现状**:
- `bindConnectionToSession` 直接覆盖 `session.id = connection.transportId`，session identity = transportId
- `createTransportBoundSession` 也是用 `transportId` 作为 session id
- **同一个 transport 只能绑定一个 session**，`bindConnectionToSession` 对同一 connection 第二次调用会直接覆盖 session 身份

**风险**: 若客户端在 session A（transportId=T1）attached 后，又发 `attach` 请求 session B（T1），daemon 会把 T1 的 session identity 换成 B，原来的 A session 从 `sessions Map` 中消失（被覆盖）。客户端以为 A 仍开着，daemon 已经把它从逻辑上删了。

**从代码看**:
```typescript
// bindConnectionToSession
session.id = connection.transportId;
session.transportId = connection.transportId;
connection.boundSessionId = session.id;
```

这里 `session.id` 被改成 `transportId`，而不是创建新 session。如果 T1 原来已经有一个 session id = T1，现在用 T1 去 bind 到另一个 tmux session，session 身份会无缝切换。**这不是 bug，是设计**（transport 即 session）。

**真正的风险**: 客户端的 session tab 切换实际上就是 transport 重绑定到不同的 tmux session。如果客户端在原 session A 还有未完成的操作（定时任务、file transfer），切走后这些操作的目标 session 身份会被污染。

### 3.2 Mirror 切换 — Subscriber Detach/Attach 时序

**现状**:
- `attachTmux` 里，先 detach `previousMirror` → 再 attach `nextMirror`
- detach: `detachMirrorSubscriber(previousMirror.subscribers, session.id)`
- attach: `mirror.subscribers.add(session.id)`

**风险**: detach 和 attach 之间有一个**极短的窗口**（同步代码块内），若此时 `broadcastChangedRangesBufferSyncToSubscribers` 触发，`session.id` 已经不在 `previousMirror.subscribers` 里，但还没有进入 `nextMirror.subscribers`，这个 subscriber 会错过这一轮的 buffer-sync。下一个 capture cycle 到来时 session 才在 `nextMirror.subscribers` 里。这会导致切 tab 后短暂的内容断层（尤其是上一个 session 输出较多时）。

**低风险但真实存在**：窗口极小（毫秒级），在慢网络下可能表现为"切换后内容瞬间旧了几行"。

### 3.3 Transport Detach — Session 删除时 Mirror Subscriber 漏清

**现状**:
- `detachSessionTransportOnly`:
  1. `sessions.delete(session.id)`
  2. `detachMirrorSubscriber(mirror.subscribers, session.id)`

**风险**: 顺序是先删 session 再清 mirror subscriber。若 `sessions.delete` 后 `getSessionMirror(session)` 仍能找到 session（因为 session 对象还在 closure 里引用），mirror subscriber 确实被清了。**没有明显泄漏**。

**但 `closeSession` 路径有差异**:
- `closeSession` 也先清 mirror subscriber 再删 session
- `closeSession` 会尝试 `session.transport.close(reason)`
- `detachSessionTransportOnly` 不会

**设计差异有意义**: detach = 只断 transport 留 session；close = 删 transport + 删 session。但两者 mirror subscriber 清理时序一致。

### 3.4 Grace Timer — 未发现

**审计结果**: 代码中**没有** `60s grace timer` 或 `closeLogicalTerminalSession` 自动触发的 timer。所有 session 关闭路径都是**同步且显式**的：
- 客户端发 `close` → `deps.closeSession()`
- transport close/error → `detachSessionTransportOnly()` → `sessions.delete()`
- mirror tmux unavailable → `destroyMirror()` → `closeLogicalSessions: false`

**历史 MEMO 中提到的 `60s grace → closeLogicalClientSession` 在当前代码中不存在**，可能在之前版本已被移除。**这是好事**。

### 3.5 Input Staleness 检测 — shouldWrite 闭包

**现状**:
```typescript
const wrote = await deps.handleInput(inputSession, data, () => {
  const current = resolveCurrentSessionForInput(connection);
  return current?.id === inputSession.id;
});
```

**风险**: `shouldWrite` 闭包捕获的是 `connection.boundSessionId`（由 `resolveCurrentSessionForInput` 读取）。若在 `flushPendingLiveMirrorInput` 的 `await runTmuxAsync` 期间，session 被重新 bind 到不同 tmux session，`shouldWrite` 会返回 false（因为 `current.id !== inputSession.id`），该 item 被正确过滤。

**这个设计是安全的**。

---

## 4. 关键发现汇总

| # | 风险 | 严重程度 | 位置 | 修复优先级 |
|---|------|----------|------|------------|
| R1 | mirror-level backpressure 的 `Math.max` 聚合会把慢 subscriber 的 backpressure 扩散给所有 subscriber，触发 overload lane | 中 | `terminal-mirror-runtime.ts:resolveMirrorLiveSyncDelay` | P2 |
| R2 | `broadcastBufferHeadToSubscribers` 没有 backpressure skip，慢 subscriber 的 `sendText` 阻塞会影响其他 subscriber 收 head | 低-中 | `terminal-mirror-runtime.ts:broadcastBufferHeadToSubscribers` | P2 |
| R3 | `flushPendingLiveMirrorInput` 的 `await runTmuxAsync` 期间若 mirror lifecycle 变 'destroyed'，`shouldWrite` 检查在 await 前，不在 await 后 | 低 | `terminal-control-runtime.ts:flushPendingLiveMirrorInput` | P3 |
| R4 | `attachTmux` 的 detach→attach 窗口可能导致切换期间 buffer-sync 丢失一轮 | 低 | `terminal-mirror-runtime.ts:attachTmux` | P3 |
| R5 | `broadcastChangedRangesBufferSyncToSubscribers` 的 `sendMessage` 同步调用在 subscriber 数多时可能串慢 | 低 | `terminal-mirror-runtime.ts:broadcastChangedRangesBufferSyncToSubscribers` | P3 |

---

## 5. 修复策略

### R1 — Per-Subscriber Mirror Cadence 解耦（最重要）

**当前**: mirror-level 的 overload lane 判断基于所有 subscriber 的最大 backpressure
**目标**: mirror capture cadence 保持（一个 tmux session 只能有一个 capture 频率），但 overload 判断改为"所有 subscriber 都在 slow lane 才降频"，而不是"任一 subscriber 慢就降频"

**修法**:
```typescript
// resolveMirrorLiveSyncDelay 中的 backpressure 判断改为：
// 若 transportBackpressureCount > 0，检查是否 ALL subscribers 都在 backpressure
// 若只有部分，在 overload lane 之前加一个 "partial" 判断，保持 fast/normal
```

或者更简单：移除 mirror-level `Math.max`，改为只以 **capture cost** 驱动 mirror cadence，不让 subscriber 网络状况影响 mirror capture 频率。Subscriber 的 backpressure 只在 buffer-sync 发送层 skip（已有）。

### R2 — Head 广播加 Backpressure Skip

**修法**: 在 `broadcastBufferHeadToSubscribers` 里也加 per-subscriber backpressure 判断，backpressure subscriber 只收到一条 `buffer-head`（不频繁），不每次光标变化都发。

### R3 — shouldWrite Double-Check

**修法**: 在 `flushPendingLiveMirrorInput` 每个 `await runTmuxAsync` 之前加 `shouldWrite` 再检查：
```typescript
if (item.shouldWrite && !item.shouldWrite()) {
  item.resolve(false);
  continue;
}
```

### R4 — Atomic Mirror Switch

**修法**: `attachTmux` 的 detach + attach 改为先加后减，或在 broadcast 触发前加锁：
```typescript
// 先加入新 mirror
nextMirror.subscribers.add(session.id);
// 再从旧 mirror 移除
if (movingBetweenMirrors) {
  detachResult = detachMirrorSubscriber(previousMirror.subscribers, session.id);
  previousMirror.subscribers = detachResult.nextSubscribers;
}
```
这样切换窗口内 session 同时在两个 mirror 的 subscriber 里，不丢广播。

### R5 — Async Broadcast

**修法**: 将 `broadcastChangedRangesBufferSyncToSubscribers` 的 `sendMessage` 调用改为 `Promise.all` 或分批 `setImmediate`，避免单个 subscriber 的阻塞影响整个 loop。

---

## 6. 红测建议

| 风险 | 红测文件 | 测试场景 |
|------|----------|----------|
| R1 | `terminal-mirror-runtime.test.ts` | 2 个 subscriber，1 个 backpressure，验证另一个 subscriber 仍走 fast lane |
| R2 | `terminal-mirror-runtime.test.ts` | backpressure subscriber 不收到光标广播 |
| R3 | `terminal-control-runtime.input-queue.test.ts` | 追加：在 flush 期间 mirror lifecycle 变 destroy，验证 item 被正确拒绝 |
| R4 | `terminal-mirror-runtime.test.ts` | attachTmux 切换时收到 buffer-sync，验证 session 不漏消息 |
| R5 | `terminal-mirror-runtime.test.ts` | 5 个 subscriber，其中 1 个 slow，验证其他 4 个在合理时间内收到广播 |

---

## 7. 当前设计亮点

- `grace timer` 已清除：没有隐式 session 关闭，session 生命周期完全由显式路径驱动
- `shouldWrite` staleness 检测设计合理，输入延迟防护有效
- `mirror.subscribers` 的 `Set<string>` 确保 subscriber 唯一性，无重复广播
- `buffer-sync` 的 per-subscriber backpressure skip 已有（但 head 广播缺）
- `createTransportBoundSession` / `bindConnectionToSession` 设计简洁：transport = session identity，不需要独立 session id 空间
