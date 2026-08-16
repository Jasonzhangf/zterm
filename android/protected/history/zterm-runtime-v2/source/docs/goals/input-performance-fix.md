# /goal: 修复 daemon 输入延迟 + tab 切换后输入卡死

## 背景与真因

### 已审计确认的瓶颈（客户端）

1. **`scheduleInputHeadRefresh` 闭包捕获 session 路由风险**
   - `queueMicrotask` 延迟执行时，`pendingInputHeadRefreshes[sessionId]` 的 `readSessionTransportSocket` 闭包已在调用点固定
   - tab 切换后，旧 tab 的 transport 可能已关闭或被 supersede，但 microtask 仍尝试向其写
   - **修复**：在 microtask 执行时，重新从当前 `transportStore` 读取 socket，不依赖闭包捕获的引用

2. **`setTimeout(32)` 最小延迟**
   - `domInputController` 中 `scheduleFlushDomInputValue` 有 `setTimeout(flush, 0)` + `setTimeout(retry, 32)`
   - 每批次输入至少附加 32ms 延迟，高频输入时累积严重
   - **修复**：Composition end 时立即 flush，不等 32ms retry；普通 keydown 直接同步调用 `sendTerminalInput`

3. **快速 tab 切换 + 未完成的 composition 输入路由错误**
   - `sessionIdRef.current` 在 React prop 变化时同步更新，但 `domInputController` 可能在 composition 结束前读取到旧 sessionId
   - **修复**：composition start 时记录当前 sessionId，composition end 必须路由到记录的 session，不依赖实时 `sessionIdRef`

### 目标交付物

1. 客户端修复（android/src/contexts/session-context-input-runtime.ts）
2. 客户端修复（android/node_modules/@zterm/shared/src/terminal/renderer.ts 的 `createTerminalDomInputController` → 需 patch 后重新构建 @zterm/shared）
3. daemon PTY write 审计（找到 daemon PTY write 阻塞点）
4. APK + daemon 升级包

## 执行步骤

### Step 1: 修复 scheduleInputHeadRefresh session 路由

修改 `session-context-input-runtime.ts`：

```
queueMicrotask(() => {
  pendingInputHeadRefreshes.delete(sessionId);
  // 每次从最新 transport store 读取，不依赖闭包捕获的 readSessionTransportSocket
  const currentWs = transportSocketStore.current.get(sessionId) || null;
  if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
    return; // transport 已失效，直接丢弃
  }
  requestSessionBufferHead(sessionId, currentWs, { force: true });
});
```

### Step 2: 修复 domInputController composition session 路由

在 `renderer.ts` 中：

```
let pendingCompositionSessionId: string | null = null;

const handleCompositionStart = () => {
  composing = true;
  pendingCompositionSessionId = sessionIdRef.current;
  resetDomInput();
};

const handleCompositionEnd = () => {
  composing = false;
  // 必须路由到 composition 开始时的 session
  const targetSessionId = pendingCompositionSessionId || sessionIdRef.current;
  pendingCompositionSessionId = null;
  if (input.value) {
    sendTerminalInput(targetSessionId, normalizeCommittedText(input.value).replace(/\n/g, '\r'));
    resetDomInput();
    focusTerminal();
  }
};
```

### Step 3: 消除 32ms flush retry

```
const scheduleFlushDomInputValue = () => {
  clearScheduledFlush();
  // 只保留一个 0ms 定时器，不再有 32ms retry
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushDomInputValue();
  }, 0);
};
```

Composition end 时直接调用 `flushDomInputValue()`，不使用 schedule。

### Step 4: Daemon PTY write 审计

找到 daemon 源码（可能在 `wterm` 仓库或构建产物 `server.cjs`），审计：

- PTY write 是否同步阻塞
- 是否有输入队列积压机制
- 多 session 并发写入是否共享同一 PTY 实例导致串行

### Step 5: 构建 + 验证

1. 修复后 `npx tsc --noEmit` 必须通过
2. 跑 `session-context-input-runtime.test.ts` 相关测试
3. 跑 `renderer.ts` 相关单元测试
4. 构建 daemon 升级包
5. 构建 APK
6. 交付

## 红测验证

- [ ] tab 切换后立即输入，输入在 500ms 内到达远端并回显
- [ ] 多 session 并发输入，无交叉路由
- [ ] 快速 tab 切换（< 200ms）时旧 session 无 pending input 泄漏
- [ ] Composition 输入（中文/表情）在 composition end 后正确路由
- [ ] daemon 无 PTY write 阻塞导致的输入排队

## 验收

提供 `zterm-0.1.3.{build}.apk` + `zterm-daemon-0.1.3-darwin-arm64.tar.gz` 到升级路径。
