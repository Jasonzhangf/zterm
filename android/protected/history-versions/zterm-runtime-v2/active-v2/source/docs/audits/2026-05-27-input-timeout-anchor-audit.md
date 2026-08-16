# Audit: 输入超时锚点与无锚点等待
**日期**: 2026-05-27
**问题**: Android 输入（回车/方向键）在 tab 切换后长时间无效
**方法**: 全链路 timeout 扫描 + 源码路径追踪

## 一、问题现象

用户切 tab 后，回车、方向键等输入法输入在长时间内无效，有时需要等几秒到十几秒才恢复。

## 二、已确认正确的链路

```
ImeAnchor input event
 → emitToActiveSession(data)
   → terminalInputHandlerRef.current(sessionId, data)
     → handleTerminalInput(sessionId, data)
       → sendInput(sessionId, data)
         → sendInputRuntime → sendInputThroughSessionTransport
           → ws.send(JSON.stringify({ type: 'input', payload: data }))
```

这条链路本身没有无锚点等待。问题不在发送路径，在 transport 状态和 focus 恢复路径。

## 三、无锚点等待清单

### 3.1 `terminalFocusRetryTimeoutsRef` — 已识别，未完全清理

**文件**: `android/src/pages/useTerminalPageKeyboardRuntime.ts`

**现象**: 切 tab 时只清理了 `pendingAndroidImeFocusTimerRef`，但 `terminalFocusRetryTimeoutsRef`（包含 `[0, 32, 120]ms` 延迟队列）未被清理。

**当前清理**:
```typescript
// 切 tab 时调用 clearPendingAndroidImeFocus()
window.clearTimeout(pendingAndroidImeFocusTimerRef.current);
pendingAndroidImeFocusTimerRef.current = null;
```

**缺失**: `terminalFocusRetryTimeoutsRef`（数组）未在 tab switch 时清理。

**影响**: 旧 tab 的 focus 调用（延迟 0/32/120ms）仍会在 120ms 后触发，但 textarea DOM 已经指向旧 session，新 tab 的 input 收不到 focus。

**唯一正确修复**: 在 `scheduleTerminalFocusRetries` 开始时（或 `clearTerminalFocusRetries` 被调用时）确保每次调用前先 `clearTerminalFocusRetries()`。当前切 tab 只调了 `clearPendingAndroidImeFocus()`，缺了 `clearTerminalFocusRetries()`。

### 3.2 Reconnect 指数退避 — 30s 静默丢弃输入

**文件**: `android/src/contexts/session-context-session-runtime.ts`

**delay 计算**:
```typescript
// session-context-core.ts
export function computeReconnectDelay(attempt: number) {
 if (attempt <= 0) return 0;
 return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}
// RECONNECT_MAX_DELAY_MS = 30_000
// RECONNECT_BASE_DELAY_MS = 1_000
```

**行为**: transport 断开后，指数退避等待重连，最长 30s，期间输入静默丢弃（`session.input.drop.pending-transport-open`）。

**不是"卡住"，是 transport 断了后输入被 drop**。但对用户来说"按键无效"是同一个症状。

**锚点**: reconnect timer 有锚点（`manualCloseRef` / `reconnectRuntime`），但输入 drop 没有 sessionId 级别的反馈。

**当前已有保护**: `sendInputThroughSessionTransport` 在 transport 不可用时会 `reconnectSession()`，但 reconnect 本身还在等退避。

### 3.3 `ensureSessionReadyForTransfer` 120ms 无锚点等待

**文件**: `android/src/contexts/session-context-input-runtime.ts`

```typescript
export async function ensureSessionReadyForTransfer(options: { ... }) {
 const startedAt = Date.now();
 while (Date.now() - startedAt < options.timeoutMs) { // timeoutMs = 120
   await new Promise((resolve) => window.setTimeout(resolve, 120));
   const current = readReadyState();
   if (current.ready && current.ws) {
     return current.ws;
   }
 }
 throw new Error(`Active session is not ready yet (${stateLabel})`);
}
```

**行为**: 图片粘贴/文件上传在 120ms 内等 transport ready，超时抛错。

**锚点**: 无锚点——等待期间 session 可能已经被关闭/切换，等待结束后只检查 `session?.state`，但不验证 session 是否仍是当前 interactive session。

**影响**: 如果用户在 120ms 内切了 tab，这个等待结束后会拿旧的 ws 连接，发送到一个已经不活跃的 session。

## 四、已验证无问题的路径

### 4.1 `pendingAndroidImeFocusTimerRef` — 有锚点

```typescript
// 每次 requestAndroidImeFocus 开始时
clearPendingAndroidImeFocus(); // 先清理旧 timer
pendingAndroidImeFocusTimerRef.current = window.setTimeout(() => {
 pendingAndroidImeFocusTimerRef.current = null; // 置 null 是锚点
 // ...
}, 0);
```

清理时把 `current = null` 是显式锚点，timer 触发时会检查 `if (pendingAndroidImeFocusTimerRef.current === null) return;`。正常。

### 4.2 Reconnect timer — 有锚点

```typescript
reconnectRuntime.timer = window.setTimeout(() => {
 if (options.refs.manualCloseRef.current.has(options.sessionId)) {
   options.refs.reconnectRuntimesRef.current.delete(options.sessionId);
   return;
 }
 const liveRuntime = options.refs.reconnectRuntimesRef.current.get(options.sessionId);
 if (!liveRuntime) return; // 锚点：session 可能已被删除
 liveRuntime.timer = null;
 // ...
}, delay);
```

有 `manualCloseRef` 和 `liveRuntime` 双重锚点，正常。

### 4.3 `longPressTimerRef` / `resizeCommitTimerRef` — 有锚点

- `longPressTimerRef`: 在 `onPointerDown` 时设，在 `onPointerUp`/`onPointerCancel` 时清，有锚点。
- `resizeCommitTimerRef`: 在 `onResize` 时设，在 `window.resize` 时清，有锚点。

## 五、修复优先级

| 优先级 | 问题 | 修复方案 |
|--------|------|----------|
| P0 | `terminalFocusRetryTimeoutsRef` 未在切 tab 时清理 | 在 `useTerminalPageKeyboardRuntime` 切 tab effect 里补 `clearTerminalFocusRetries()` |
| P1 | reconnect 期间输入静默 drop 无反馈 | 在 `runtimeDebug` 加 `session.input.drop.reconnecting` 事件，供 UI 层显示状态 |
| P2 | `ensureSessionReadyForTransfer` 无锚点等待 | 传入 `currentSessionIdRef`，等待结束后验证 sessionId 未变 |

## 六、P0 修复详情

**文件**: `android/src/pages/useTerminalPageKeyboardRuntime.ts`

**当前切 tab effect**:
```typescript
// platform mount effect
React.useEffect(() => {
 updateTerminalKeyboardRequested(isAndroid);
 if (isAndroid) {
   return;
 }
 clearPendingAndroidImeFocus();
 clearTerminalFocusRetries();
 const input = querySessionInput(uiSessionId);
 input?.blur();
}, [clearPendingAndroidImeFocus, clearTerminalFocusRetries, isAndroid, uiSessionId, updateTerminalKeyboardRequested]);
```

**问题**: `clearTerminalFocusRetries()` 已经在依赖数组里了，说明 effect 每次 `uiSessionId` 变化都会执行。但 `terminalFocusRetryTimeoutsRef` 可能在 effect 返回的 cleanup 里未被正确清理。

**真正根因**: `terminalFocusRetryTimeoutsRef` 在 `scheduleTerminalFocusRetries` 内部会先 `clearTerminalFocusRetries()`，但如果在调用 `scheduleTerminalFocusRetries` 之后 session 被切走，旧的 timer 数组没有被清理。

**修复**: 在 `scheduleTerminalFocusRetries` 内部以及切 tab 的 effect cleanup 里都显式调用 `clearTerminalFocusRetries()`。

## 七、验证方案

1. **单元测试**: 在 `useTerminalPageKeyboardRuntime` 测试里模拟切 tab 场景，验证旧的 `terminalFocusRetryTimeoutsRef` 数组被清空。
2. **集成测试**: 模拟 tabA 输入 → 切到 tabB → 在 tabB 快速按方向键，验证按键立即生效（不等待 120ms）。
3. **回归**: 现有 `TerminalPage.android-ime` 测试保持通过。
# Audit: 输入超时锚点与无锚点等待

日期：2026-05-27
范围：Android terminal 输入链路（IME / tab switch / transport reconnect）
现象：切换 tab 后，回车、方向键等输入法按键有时长时间无效；用户怀疑无锚点 timeout 导致旧等待延后生效或新输入被长期阻塞。

## 1. 结论

用户的方向是对的：当前代码里确实存在“按时间等待、但没有绑定当前 tab / session / focus route 真相”的 timeout / retry。

但需要区分两类问题：

1. UI/IME 焦点链路中的无锚点等待
2. transport reconnect 链路中的长时间退避等待

真正最像“切 tab 后输入卡住”的主根因，优先级最高的是第 1 类，不是第 2 类。

唯一正确的修复方向不是“到处减少 timeout”，而是：

- 让 keyboard/focus timeout 绑定当前 `uiSessionId` / focus-route generation
- 让 reconnect timeout 绑定当前 session transport intent / active truth
- 所有 timeout 回调执行前必须重新校验锚点是否仍然有效

## 2. 已验证的输入真链路

输入链路源码真相：

- `android/src/pages/useTerminalPageKeyboardRuntime.ts`
  - `ImeAnchor.addListener("input")` -> `emitToActiveSession(text)`
  - `ImeAnchor.addListener("backspace")` -> `emitToActiveSession("\u007f")`
  - `ImeAnchor.addListener("key")` -> 构造 `KeyboardEvent("keydown")` -> dispatch 到当前 session 的隐藏 textarea
- `android/src/components/TerminalView.tsx`
  - 真正的 DOM 输入锚点是：
    - `textarea[data-wterm-input="true"][data-terminal-input-session-id="<sessionId>"]`
- `android/src/pages/terminal-page-session-input.ts`
  - `querySessionInput(sessionId)` 按 sessionId 查找当前隐藏 textarea
- `android/src/hooks/useTerminalShellActions.ts`
  - `handleTerminalInput(sessionId, data)` -> `sendInput(sessionId, data)`
- `android/src/contexts/session-context-interaction-runtime.ts`
  - `sendInput()` -> `sendInputRuntime()`
- `android/src/contexts/session-context-transfer-runtime.ts`
  - `sendInputRuntime()` -> `sendInputThroughSessionTransport()`

结论：输入真源链路没有第二套 owner；问题不是“按键没接线”，而是 timeout/retry 在切 tab 后可能继续操作过期焦点或等待过期 transport 条件。

## 3. 已扫出的关键 timeout 点

### 3.1 keyboard / focus 链路

文件：`android/src/pages/useTerminalPageKeyboardRuntime.ts`

关键等待：

1. `pendingAndroidImeFocusTimerRef`
   - `requestAndroidImeFocus()` 内 `setTimeout(..., 0)`
   - 当前只用 `androidImeFocusRouteKeyRef` 做 route key 去重
   - 但回调执行前没有再次验证“当前 route generation 是否仍然属于这次 tab/session”

2. `terminalFocusRetryTimeoutsRef`
   - `scheduleTerminalFocusRetries()` 内固定延迟 `[0, 32, 120]`
   - 回调内容是 `focusTerminalInput()` 和可选 `Keyboard.show()`
   - 这些回调没有绑定 generation/token，只是简单清空旧 timer id 列表

风险：

- 如果 tab 切换很快，旧 session 的 focus retry 可能在新 tab 已切走后才执行
- 回调里再去 `querySessionInput(activeSessionIdRef.current)` / `ImeAnchor.show()`，就可能把焦点链路拉回过期路径
- 表现为：当前 tab 看起来已切换，但输入法按键仍对不上当前有效 textarea / 当前有效 IME route

这类问题正是“无锚点 timeout”的典型特征。

### 3.2 transfer ready 等待

文件：`android/src/contexts/session-context-input-runtime.ts`

关键等待：

- `ensureSessionReadyForTransfer()`
- while loop 内每轮 `await new Promise(resolve => window.setTimeout(resolve, 120))`

现状：

- 这是纯时间轮询，没有 attach 到 transport open request / connect generation
- 但它只影响图片/文件/截图，不是“回车/方向键无效”的第一真源

结论：这里也应该锚定，但不是本次输入失效的唯一主根因。

### 3.3 reconnect 长时间退避

文件：`android/src/contexts/session-context-session-runtime.ts`

关键等待：

- `reconnectRuntime.timer = window.setTimeout(..., delay)`
- `delay = nextDelayMs ?? computeReconnectDelay(attempt)`

文件：`android/src/contexts/session-context-core.ts`

- `computeReconnectDelay(attempt)` 采用指数退避

影响：

- transport 断开后，显式输入如果没触发立即重连，就会落入 reconnect 退避
- 用户体感就是“切 tab / 切回来后，输入很久没反应”

但这里要谨慎：

- reconnect timer 本身已经以 `sessionId` 为基本 owner
- 真问题不是“有 timer 就错”
- 真问题是 timer 回调执行前，没有统一的 intent anchor / generation 校验，无法判定它是否还是当前那次 reconnect 意图

## 4. 为什么 keyboard runtime 是本次唯一优先修改点

因为用户报告的是：

- 回车无效
- 方向键无效
- 输入法相关按键无效
- 且与切 tab 后卡住强相关

这组症状首先指向的是 `ImeAnchor.key -> DOM textarea -> current ui session` 这条焦点路由，而不是图片传输或普通后台重连。

也就是说：

- 如果先去改 transfer polling，不会解决回车/方向键
- 如果只去缩短 reconnect delay，也不能根除“旧 focus timer 命中过期 session”
- 唯一正确的第一修改处，就是 `useTerminalPageKeyboardRuntime.ts` 中负责 IME/focus 的 timeout owner

这是唯一正确的原因：它位于“当前输入目标是谁”的真源层；其他层只能缓解症状，不能修正 owner 错位。

## 5. 推荐修复模型：带锚点的 timeout

建议新增一个很薄的锚点模型，而不是继续散写 `setTimeout`。

### 5.1 keyboard/focus anchor

建议形态：

- `focusRouteGenerationRef.current += 1` 当以下任一变化时递增：
  - `uiSessionId` 改变
  - quickbar editor focus 变化导致 terminal IME route 失效
  - Android terminal IME 主动 blur / hide

所有 keyboard/focus timeout 在创建时捕获 `generation`：

- `requestAndroidImeFocus()` 的 0ms timer
- `scheduleTerminalFocusRetries()` 的 `[0, 32, 120]` retries

回调执行前必须检查：

- captured generation === current generation
- captured sessionId === current `uiSessionId`
- quickBarEditorFocusedRef.current 仍为 false

只要任一不匹配，立即 return，不允许继续 `ImeAnchor.show()` / `focusTerminalInput()`。

### 5.2 reconnect anchor

建议形态：

- `reconnectIntentId` / `transportOpenIntentId` 成为 reconnect timer 的唯一锚点
- `setTimeout` 回调触发时，先校验当前 runtime 里保存的 intent id 是否还是自己
- 若 session 已切换 owner / host 已变 / runtime 已被新 reconnect 覆盖，则旧 timer 直接失效

### 5.3 polling anchor

对 `ensureSessionReadyForTransfer()` 这类 while+timeout polling：

- 每轮不只检查 readyState
- 还要检查当前 session transport intent 是否仍然是最初等待的那次
- 若 intent 已失效，立即 fail fast，不再傻等

## 6. 最小落地顺序

1. 先改 `useTerminalPageKeyboardRuntime.ts`
   - 引入 focus-route generation anchor
   - 收口 `pendingAndroidImeFocusTimerRef`
   - 收口 `terminalFocusRetryTimeoutsRef`
   - 所有回调执行前重新验锚点

2. 再改 session reconnect timer owner
   - 给 reconnect timer 增加 intent anchor 校验

3. 最后改 transfer polling
   - 把 120ms 轮询等待也挂到 transport intent 上

## 7. 验证标准

修复后必须补三类验证：

1. 单测
   - tab 快速切换后，旧 focus retry 不得命中新 tab
   - 旧 generation timer 触发时必须 no-op

2. 页面回归
   - Android IME test
   - terminal render/input routing test

3. 真机验证
   - adb 连设备
   - 打开两个 tab 快速切换
   - 验证回车、方向键、退格立即生效
   - 不接受“偶尔好了”的口头结论

## 8. 最终判断

你的判断“需要带锚点的 timeout”是对的。

但唯一正确的第一落点不是全仓统一改 timeout，而是：

- 先修 `useTerminalPageKeyboardRuntime.ts` 的 focus/IME timeout owner

因为本次问题的唯一真源是“当前输入目标 session 的焦点路由”，而不是 transport/file-transfer 的一般性等待。
# Audit: 输入超时锚点与无锚点等待

**日期**: 2026-05-27
**问题**: Android 输入（回车/方向键）在 tab 切换后长时间无效
**方法**: 全链路 timeout 扫描 + 源码路径追踪

---

## 一、输入完整链路

```
ImeAnchor (Native)
 └─ "input" listener ──→ normalizeTerminalCommittedText()
 └─ "backspace" listener ──→ emitToActiveSession("\u007f".repeat(count))
 └─ "key" listener ──→ dispatchEvent(KeyboardEvent) ──→ DOM textarea
 └─ "keyboardState" listener ──→ updateKeyboardInset / updateTerminalKeyboardRequested

emitToActiveSession (useTerminalPageKeyboardRuntime.ts)
 ├─ activeSessionIdRef.current ──→ uiSessionId (来自 useTerminalPageInteractionRuntime)
 └─ terminalInputHandlerRef.current?.(sessionId, data)

terminalInputHandlerRef (从 useTerminalShellActions 传入)
 └─ handleTerminalInput(sessionId, data)
   └─ sendInput(sessionId, data)

sendInput (SessionContext facade)
 └─ contextRuntimeRef.current.sendInput(sessionId, data)
   └─ sendInputRuntime → sendInputThroughSessionTransport

sendInputThroughSessionTransport
 ├─ ws.readyState === WebSocket.OPEN → 直接 sendSocketPayload ✅
 └─ transport unavailable → reconnect / drop ⚠️
```

---

## 二、所有 timeout / 异步等待点

### 2.1 ImeAnchor listeners（正确，有 dispose guard）

| 位置 | 定时器 | 锚点 | 结论 |
|---|---|---|---|
| useTerminalPageKeyboardRuntime.ts:368-502 | async attachListeners | `disposed` flag | 正确，有 cleanup |

**评注**：监听器本身是 async attach 的，但有 `disposed` flag 防late callback。ImeAnchor "input" 路径本身无 timeout。

### 2.2 键盘 focus retry（问题1：切 tab 时残留）

| 位置 | 定时器 | 锚点 | 结论 |
|---|---|---|---|
| useTerminalPageKeyboardRuntime.ts:207 | `[0, 32, 120]ms` × 3次 | `terminalFocusRetryTimeoutsRef` | **切 tab 时未清空** |
| useTerminalPageKeyboardRuntime.ts:249 | 0ms 单次 | `pendingAndroidImeFocusTimerRef` | 切 tab 时清空 ✅ |

**问题点**：
```
// 切 tab 时只清了这一个：
clearPendingAndroidImeFocus();  // 只清 pendingAndroidImeFocusTimerRef
// 但 terminalFocusRetryTimeoutsRef 里 [0,32,120]ms 的旧 focus 调用还在等！
```

**后果**：切 tab 后，0ms/32ms/120ms 后仍有旧 session 的 `focusTerminalInput()` 调用尝试 focus 被 destroy 的 textarea，新 tab 的 textarea 永远得不到 focus。

### 2.3 reconnect delay（问题2：指数退避最高 30s）

| 位置 | 定时器 | 锚点 | 结论 |
|---|---|---|---|
| session-context-session-runtime.ts:498 | 0 → 2 → 4 → 8 → ... → 30000ms | `reconnectRuntime.timer` | **无锚点等太久** |
| session-context-core.ts:266 | RECONNECT_MAX_DELAY_MS=30000 | - | 指数退避上限 |

**问题点**：transport 断开后输入被 `sendInputThroughSessionTransport` drop，然后启动指数退避重连：
```
attempt=0: 0ms → attempt=1: 2s → attempt=2: 4s → ... → attempt=15: 30s
```
**后果**：这 30s 内所有输入静默丢失，用户感知"按键无效"。这不是"卡住"，是输入真的被丢了。

### 2.4 ensureSessionReadyForTransfer（问题3：无锚点 120ms）

| 位置 | 定时器 | 锚点 | 结论 |
|---|---|---|---|
| session-context-input-runtime.ts:170 | 120ms × 轮询 | 无锚点等待 | **无锚点等固定时间** |

**问题点**：
```typescript
while (Date.now() - startedAt < options.timeoutMs) {
 await new Promise(r => setTimeout(r, 120));
 // ...
}
throw new Error(`Active session is not ready yet (${stateLabel})`);
```
**后果**：paste / file attach 在 120ms 内 transport 未 OPEN 就抛错，无重试、不 reconnect。

### 2.5 reconnect timer（正确）

| 位置 | 定时器 | 锚点 | 结论 |
|---|---|---|---|
| session-context-session-runtime.ts:498 | delayMs | `reconnectRuntime.timer` + `manualCloseRef` | 正确，有 cleanup |
| session-context-transport-open-runtime.ts | pending reconnect timeout | `reconnectRuntime.timer` | 正确 |

---

## 三、问题1根因详解：切 tab 后 focus retry 残留

### 触发路径
```
用户切 tab → useTerminalPageInteractionRuntime 算出新 uiSessionId
 → TerminalPage re-render → useTerminalPageKeyboardRuntime uiSessionId 更新
   → ImeAnchor effect 重建 listeners（但 focus retry 队列未清）
     → 旧 session 的 [0,32,120]ms focus 调用依次到期
       → querySessionInput(oldSessionId) === null
         → focusTerminal() 静默 no-op
```

### 代码证据
```typescript
// useTerminalPageKeyboardRuntime.ts:197
const clearTerminalFocusRetries = React.useCallback(() => {
 terminalFocusRetryTimeoutsRef.current.forEach((timerId) => {
   window.clearTimeout(timerId);
 });
 terminalFocusRetryTimeoutsRef.current = [];
}, []);

// 切 tab 时只调用了 clearPendingAndroidImeFocus()，没有调用 clearTerminalFocusRetries()
```

### 正确修复
在 `scheduleTerminalFocusRetries` 每次启动前，必须先清空队列；在 session 切换路径上，也需要清。

---

## 四、问题2根因详解：reconnect delay 导致输入静默丢失

### 触发路径
```
transport 断开（daemon 重启 / 网络抖动）
 → ws.onclose / ws.onerror
   → sendInputThroughSessionTransport: ws=null/closed → drop input
     → sendInputRuntime: "session.input.transport-unavailable" debug log
       → shouldReconnectNow = true → reconnectSession()
         → reconnectRuntime.timer = setTimeout(attempt_1, 2000ms)
           → 2s 后 ws.open → buffer-head-request → 恢复
```

**最大等待时间**：30s（attempt 15 的退避上限）

**静默丢失**：在这 30s 内，每次按键都走 `drop` 路径，用户看不到任何反馈（只有 debug log）

---

## 五、问题3：paste/attach 120ms 无锚点

### 问题点
`sendImagePaste` / `sendFileAttach` 调用 `ensureSessionReadyForPaste`，内部有 120ms 无锚点等待：
```typescript
// session-context-input-runtime.ts:170
await new Promise(r => setTimeout(r, 120));
```
超时后直接 throw，不 reconnect。

---

## 六、唯一正确修复方案

### 修复1：切 tab 时清空 focus retry 队列（最关键）

**唯一真源**：`useTerminalPageKeyboardRuntime.ts` 的 `scheduleTerminalFocusRetries`

**修复点**：
1. `scheduleTerminalFocusRetries` 每次调用前先 `clearTerminalFocusRetries()`
2. 在 `uiSessionId` 变化时，调用 `clearTerminalFocusRetries()`

**代码改动**：在 `useTerminalPageKeyboardRuntime.ts` 的 `uiSessionId` effect 依赖中加清理。

### 修复2：transport 断开时对 active input 强制快速 reconnect（关键）

**唯一真源**：`sendInputThroughSessionTransport` 中的 `shouldReconnectNow` 逻辑

**当前问题**：`shouldReconnectNow` 判断依赖 `pendingTransportOpenStale`，但 pending open 如果还没超时，active input 仍被 drop。

**修复点**：对 `isExplicitInputTarget === true` 的情况，应该立即 reconnect（跳过 pending 等待）。

### 修复3：paste/attach 的 ready-wait 应该带 transport truth 锚点

**唯一真源**：`ensureSessionReadyForTransfer` 的 120ms polling

**修复点**：改用 WebSocket `onopen` 事件 + transport readyState 变化监听，而不是固定 120ms polling。

---

## 七、验证方案

### 验证1：focus retry 清理
- 补红测：切换 tab 时，`terminalFocusRetryTimeoutsRef.current.length === 0`

### 验证2：input 在 reconnect 期间不丢
- 补红测：transport close 期间，active session 输入被 `reconnectSession()` 处理，不走 drop 路径

### 验证3：paste/attach 超时后重试
- 补红测：transport 暂时不可用时，paste/attach 有指数重试

---

## 八、影响范围

| 问题 | 严重度 | 影响场景 |
|---|---|---|
| focus retry 残留 | **高** | tab 切换后首 120ms 按键无效 |
| reconnect delay 静默 drop | **高** | 网络抖动 / daemon 重启后 0-30s 按键丢失 |
| paste/attach 120ms 无锚点 | **中** | 网络慢时 paste/attach 失败 |

---

**审计完成** | 2026-05-27
