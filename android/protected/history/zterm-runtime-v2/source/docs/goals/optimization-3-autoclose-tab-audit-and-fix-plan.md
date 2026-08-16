# Optimization: 自动关闭 tab 审计与修复

## 目标
查证并修复"切换 tab/重连/后台同步时 tab 自动关闭"的根因。AGENTS.md 已冻结规则：OPEN_TABS 是唯一真源，runtime sessions 只补 transport/state；不允许用 `open tabs ∩ runtime sessions` 过滤导致 UI 消失。

## 审计路径
从审计报告的 remote-tab-audit 逻辑倒查入口：

### 入口路径 A: `auditOpenTabsAgainstRemoteSessions`
文件：`src/lib/remote-tab-audit.ts:63-82`
行为：向 daemon 请求远程 tmux session 列表。若某个 open tab 的 sessionName 不在远程列表 → 记录到 runtimeDebug。
当前实现**只记录不删除**。正确。

### 入口路径 B: `closeSessionRuntime`
文件：`src/contexts/session-context-session-runtime.ts:226-314`
行为：`deleteSessionSync(options.sessionId)` 从 state 移除 session。同时 `openTabStateRef.current` 只在 `applyClosedOpenTabIntent` 时才移除 tab。

需要验证：**有没有路径只调 `closeSession` 但不调 `applyClosedOpenTabIntent`**？

### 入口路径 C: `session-context-core.ts:104`
`DELETE_SESSION` reducer：
```ts
case 'DELETE_SESSION':
  const nextLiveSessionIds = ... // 过滤 sessionId
  if (filteredLiveSessionIds.length === 0 && nextActiveSessionId)
    return [nextActiveSessionId]
  ...
```
`DELETE_SESSION` 只从 `sessions` 和 `liveSessionIds` 移。不碰 `OPEN_TABS`。正确。

### 入口路径 D: `foregroundRefreshRuntime`
文件：`hooks/useOpenTabLifecycleEffects.ts`
`visibilitychange` → `foregroundRefreshRuntime` 触发 `auditOpenTabsAgainstRemoteSessions`。已确认只记录不删除。

### 入口路径 E: `materializeOpenTabRuntimeSessions`
文件：`hooks/useOpenTabRuntime.ts:185`
通过 `openTabState.tabs` materialize 成 `terminalSessions`。不会过滤。但在 App.tsx 的 `TerminalPage` 传入 `openTabs={openTabState.tabs.map(...)}` —— 这里 `tabs` 真源来自 persist。正确。

## 根因收敛
自动关闭的真因最可能是：
1. **daemon 端 `closeSession` / `destroyMirror` 被意外触发** → daemon 发 `{type: 'closed'}` 给客户端 → 客户端 `handleMessage` 收到 `closed` → 调用 `closeSession` → 同时 `manualCloseRef` 未标记 → 后续 `liveSessionIds` 过滤把该 session 从 UI 移除了。
2. **`liveSessionIdsExplicit` 被重置**：`SET_ACTIVE_SESSION` 时 `liveSessionIdsExplicit ? state.liveSessionIds : [action.id]` → 若 non-explicit 且 active session 切走旧 session 丢失 live flag → `liveSessionIds` 不再包含 → `buildPassiveVisibleRefreshTargets` 不再返回 → UI tab chrome 可能过滤。
3. `ensureActiveSessionFresh` source='active-tick' 的 `allowReconnectIfUnavailable: true` → transport 不存在时尝试 reconnect → 连接失败 → session 被标记 state=disconnected → UI 可能会过滤。

## 修复方向

### Fix 1: 客户端收到 daemon `closed` 消息时不自动 close tab（P0）
文件：`src/contexts/session-context-message-assemblies.ts`
- 当前收到 `closed` → 走 `closeSession` 路径 → 从 state 删除
- 改：收到 `closed` 只标记 `state = 'disconnected'`，不从 state 删除
- 仅用户显式 `closeSession` 才从 state 和 OPEN_TABS 双删除

### Fix 2: `liveSessionIds` 不从 state 删除 session（P1）
文件：`src/contexts/session-context-core.ts` DELETE_SESSION reducer
- 当前：`DELETE_SESSION` 从 `liveSessionIds` 过滤
- 保持，但确保 `DELETE_SESSION` 只被 `closeSessionRuntime` 调用（用户显式关闭）
- 增加断言：`manualCloseRef.current.has(sessionId)` 必须为 true 才执行 `DELETE_SESSION`

### Fix 3: `allowReconnectIfUnavailable` 在非 foreground 场景不触发 reconnect（P2）
文件：`src/contexts/session-context-lifecycle.ts`
- `ensureActiveSessionFresh` 的 `allowReconnectIfUnavailable: true` 仅在 foreground 时允许
- 背景 tick 不触发 reconnect

## 验证
- 模拟 daemon 发送 `{type:'closed'}` → 客户端不删除 tab，只标记 disconnected
- `closeSessionRuntime` 从 user intent 触发 → tab 从 OPEN_TABS 和 state 双移除
- 背景 tick 不触发 reconnect

## DoD
- [ ] Fix 1-3 apply_patch
- [ ] 新增定向红测覆盖 daemon closed 不删除 tab 路径
- [ ] contracts PASS
- [ ] tsc PASS
- [ ] APK 交付
