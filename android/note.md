# note

## Input path audit (2026-06-19)

### Full client-side input chain
```
domInputController.handleInput() / handleBeforeInput()
  → sendTerminalInput(value)
    → onInputRef.current(sessionId, value)  [sessionIdRef.current = sessionId prop]
      → TerminalView.onInput(sessionId, data)
        → handleTerminalInput(sessionId, data)
          → sendInput(sessionId, data)      [via useSession context]
            → sendInputRuntime() / sendInputThroughSessionTransport()
              → sendSocketPayload(sessionId, ws,
                  JSON.stringify({type:'input', payload: data}))
                → WebSocket.send()           [ws.readyState === OPEN]
                  → daemon receives JSON {type:'input', payload}
                    → PTY.write(data)        [bottleneck: PTY write may block]
```

### Bottleneck analysis
- After tab switch, `scheduleInputHeadRefresh` captures stale `readSessionTransportSocket` closure.
- `queueMicrotask` delay means head refresh may target wrong transport.
- Fix: add session ID version/epoch check before `requestSessionBufferHead` call.
- `sessionIdRef.current = sessionId` updates synchronously on prop change (line 484).
- `domInputController` uses `sessionIdRef.current` on next input event → correct if no pending input.
- Risk: rapid tab switch + pending composition may route to wrong session.
- `setTimeout(0)` + `setTimeout(32)` retry → 32ms minimum latency on every commit.
- For high-frequency typing, this adds at least 32ms per batch.

### Daemon PTY write (in `server.cjs`)
```javascript
ws.on("message", (msg: Buffer | string) => {
  const input = typeof msg === "string" ? msg : msg.toString("utf-8");
  ptyProcess.write(input);  // blocking write to PTY
});
```

### Status
- TypeScript: `npx tsc --noEmit` → **No errors found** ✓
- All prior R5/R2/R1 work remains intact.
- Need: daemon source to audit PTY queue depth + write scheduling.

## 2026-06-21 自动关闭Tab根因审计

### 问题现象
- 远程 daemon 上 tmux session 仍然存在，但客户端 audit 逻辑误判为"不存在"并错误关闭 tab

### 根因链路追踪

#### 触发路径
1. `useOpenTabLifecycleEffects.ts` 监听 `SESSION_STATUS_EVENT`（type='closed'）
2. 触发 `auditOpenTabsAgainstRemoteSessions('session-status-closed')`

#### 审计链路
1. `remote-tab-audit.ts::auditOpenTabsAgainstRemoteSessions()`
2. 调用 `fetchRemoteTmuxSessionNamesByOwner()` 获取远程会话列表
3. 对每个 tab 检查 `tab.sessionName.trim()` 是否在远程会话列表中

#### 根因发现
`fetchRemoteTmuxSessionNamesByOwner()` 返回**空 Map 或空数组**，导致：
- `remoteSessionNames = []` → `!remoteSessionNames` 为 false（数组不是 falsy）
- 但 `new Set([]).has('sessionName')` = false
- tab 被标记为 missing，触发 tab 关闭

#### 失败原因分析
1. WebSocket 连接失败或超时（2500ms）
2. daemon 返回错误响应（type !== 'sessions'）
3. 客户端缓存旧结果或版本不兼容

### 修复策略
1. **门禁强化**：audit 失败时只记录 debug，不主动关闭 tab
2. **降级处理**：网络失败时不触发 tab 关闭，只保留 tab 并等待下次审计
3. **红测覆盖**：测试 WebSocket 失败、超时、错误响应场景

## 2026-06-22 升级包 404 审计

### 现象
- App 能读到 `latest.json`
- 弹窗显示 `Remote: 0.1.3.1860 / versionCode 1031860`
- 点击“立即升级”后原生插件报 `下载升级包失败：HTTP 404`

### 根因
- `android/update-dist/latest.json` 与 `~/.wterm/updates/latest.json` 都指向 `zterm-0.1.3.1860.apk`
- 但 `~/.wterm/updates/` 实际缺少该文件，只存在 `zterm-0.1.3.1862.apk` 等其他版本
- daemon HTTP `/updates/<apk>` 从 `~/.wterm/updates` 读文件；manifest 命中但文件缺失时必然 404

### 处理
- 先把 `android/update-dist/zterm-0.1.3.1860.apk` 补拷贝到 `~/.wterm/updates/zterm-0.1.3.1860.apk`
- 新增 `scripts/verify-update-bundle.mjs`
- `build-android-debug.sh` 发布后强制校验：
  - `update-dist/latest.json` 与 `~/.wterm/updates/latest.json` 版本一致
  - 两侧 versioned APK 均存在
  - 两侧 APK sha256 / size 与 manifest 一致
- `zterm-latest-debug.apk` alias 与 versioned APK 一致

### 复核结果
- 当前 daemon 更新目录已补齐 `zterm-0.1.3.1863.apk`
- `http://127.0.0.1:3333/updates/zterm-0.1.3.1863.apk` 返回 `200`
- `http://100.66.1.82:3333/updates/zterm-0.1.3.1863.apk` 返回 `200`
- `android/scripts/verify-update-bundle.mjs` 结果为 `ok: true`
- 当前 `android/update-dist/latest.json` 和 `~/.wterm/updates/latest.json` 都指向 `0.1.3.1863`

## 2026-06-22 optimization-1 构建门禁补充

### 验证结果
- `npx tsc --noEmit` PASS
- 定向红测 PASS：
  - `src/components/TerminalView.test.tsx`
  - `src/components/TerminalView.dynamic-refresh.test.tsx`
  - `src/pages/TerminalPage.render-scope.test.tsx`
  - `src/contexts/session-context-lifecycle.test.tsx`
  - `src/contexts/SessionContext.ws-refresh.test.tsx`
- `pnpm run test:terminal:contracts` PASS（`564/564`）
- `pnpm run test:terminal:regression` PASS
- `./scripts/build-android-debug.sh` PASS

### 构建链路卡点
- `capacitor-cordova-android-plugins/src/main/res/.gitkeep` 与 `src/main/java/.gitkeep` 不能在构建前删除
- 删除后 AGP `:capacitor-cordova-android-plugins:parseDebugLocalResources` 会报 `!directory.isDirectory()`
- 已移除 `build-android-debug.sh` 中删除 `.gitkeep` 的逻辑

### 当前升级包
- `android/update-dist/zterm-0.1.3.1866.apk`
- `~/.wterm/updates/zterm-0.1.3.1866.apk`
- `http://100.66.1.82:3333/updates/latest.json` 指向 `0.1.3.1866`
- `http://100.66.1.82:3333/updates/zterm-0.1.3.1866.apk` 返回 `200`

## 2026-06-22 optimization 续做：background tick / closed transport / delete gate

### 本轮改动
- `session-context-lifecycle.ts`
  - active tick 在后台改为 `1000ms` cadence，不再沿用前台 `16ms+` 刷新周期
  - passive tick 在后台只保留单条 `1000ms` timer，移除原先重复排队
  - `active-tick` 的 `allowReconnectIfUnavailable` 改为读取 `foregroundActiveRef.current`
- `session-context-core.ts`
  - `DELETE_SESSION` action 增加 `manualClose: true` 类型门禁
- `session-context-infra-runtime.ts` / `session-context-infra-facade-runtime.ts`
  - `deleteSessionSyncRuntime()` 只发送带 `manualClose: true` 的 `DELETE_SESSION`
- `session-context-transport-open-runtime.ts`
  - transport 收到 server `closed` 后，先把 session state 落到 `closed`，再发 `zterm:session-status`

### 验证
- `cd android && npx tsc --noEmit` PASS
- `cd android && pnpm exec vitest run src/contexts/session-context-lifecycle.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx src/contexts/session-context-session-runtime.test.ts` PASS
- `cd android && pnpm run test:terminal:contracts` PASS
  - `49 files / 561 tests` 全绿

### 新增红测
- `session-context-lifecycle.test.tsx`
  - `foreground=false` 时 timeout delay `>= 900ms`
- `SessionContext.ws-refresh.test.tsx`
  - websocket `closed` message 后 session state 变为 `closed`
  - 后续底层 socket close 不再重复触发 reconnect/status

### 当前缺口
- client optimization-1 还没完成 `TerminalView` 的 split 32ms RAF 节流与 `renderGeometryRevision` effect 收口
- daemon optimization-2 还没跑 throughput bench，也没交付新 APK
- 本轮只完成代码 + contracts 闭环，未构建 APK
