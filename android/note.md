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

## 2026-06-22 optimization-3 自动关闭 tab close/disconnected closeout

### 本轮改动
- `SessionState` 新增 `disconnected`，表示 transport 断开但 runtime session / OPEN_TABS 仍保留。
- daemon websocket `{ type: "closed" }` 经过 `buildSessionClosedUpdates()` 后只把 session 标记为 `disconnected`，不落成用户显式关闭态。
- `buildActiveSessionRefreshPlan()` 将 `closed/disconnected/error` 都视为 unavailable，只有 `explicit-resume` 可以恢复。
- debug UI 将 `disconnected` 显示为 closed 风格状态，但不删除 tab。

### 删除门禁审计
- 生产代码中 `deleteSessionSync()` 只有一个调用点：`closeSessionRuntime()`。
- `closeSessionRuntime()` 先执行 `manualCloseRef.current.add(sessionId)`，之后才调用 `deleteSessionSync(sessionId)`。
- `SessionAction.DELETE_SESSION` 类型要求 `manualClose: true`，`deleteSessionSyncRuntime()` 只发送该类型 action。
- 因此 daemon closed / transport detach / auditOpenTabsAgainstRemoteSessions 均没有直接删除 OPEN_TABS 的路径。

### 验证
- `cd android && npx tsc --noEmit` PASS。
- `cd android && pnpm exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/App.dynamic-refresh.test.tsx src/contexts/session-sync-helpers.test.ts src/contexts/session-context-activity-runtime.test.ts src/contexts/session-context-transport-open-runtime.test.ts src/contexts/session-context-lifecycle.test.tsx` PASS（279/279）。
- `cd android && pnpm exec vitest run src/contexts/session-context-session-runtime.test.ts src/contexts/session-context-core.test.ts` PASS（14/14）。
- `cd android && pnpm run test:terminal:contracts` PASS（564/564）。
- `cd android && ./scripts/build-android-debug.sh` PASS。
- 新 APK：`~/.wterm/updates/zterm-0.1.3.1869.apk`，versionCode `1031869`，sha256 `49859962c5a65dfa610b27ece2d577c97feb584875eea945d2ec1f60ee653eb9`，size `5459890`。
- HTTP 验证：
  - `http://127.0.0.1:3333/updates/latest.json` 200，APK 200。
  - `http://100.66.1.82:3333/updates/latest.json` 200，APK 200。

## 2026-06-22 升级包 404 二次修复

### 现象
- App 能检查到升级包，但点击升级下载 APK 报 HTTP 404。
- 现场弹窗仍显示旧版本 `0.1.3.1860`，而当前 daemon 更新目录已发布 `0.1.3.1866+`。

### 根因
- 文件侧已正常：`~/.wterm/updates/latest.json` 与 versioned APK 均存在。
- 客户端 `startUpdate(manifest)` 会直接使用 UI 里旧的 `availableManifest/latestManifest`，不会在安装前重新 `no-store` 拉最新 manifest。
- 因此 UI 手里的旧 `apkUrl` 可以继续被拿去下载，造成 manifest 检查成功但下载旧 APK 404。

### 修复
- `app-update-runtime.ts`
  - 新增 `refreshing-manifest` stage。
  - `startUpdate()` 在 native support / backup / install 前必须重新拉 `snapshot.preferences.manifestUrl`。
  - 校验最新 manifest 的 `versionCode + sha256` 与用户确认安装的目标一致，否则中止并提示重新检查更新。
  - 真实下载只使用刚复核的 manifest URL，避免 stale host / stale APK。
- `app-update-runtime.test.ts`
  - 红测：旧 install target 被最新 manifest 拒绝，且不会 backup / download。
  - 正测：同版本同 sha 时安装使用复核后的同源 URL，不使用旧 snapshot apkUrl。

### 验证
- `cd android && npx tsc --noEmit` PASS。
- `cd android && pnpm exec vitest run src/lib/app-update-runtime.test.ts src/hooks/useAppUpdate.test.tsx` PASS（12/12）。
- `cd android && pnpm run test:terminal:contracts` PASS（564/564）。
- `cd android && ./scripts/build-android-debug.sh` PASS。
- 新升级包：
  - `android/update-dist/zterm-0.1.3.1868.apk`
  - `~/.wterm/updates/zterm-0.1.3.1868.apk`
  - versionCode `1031868`
  - sha256 `8f7826a51675465197dae6f3f2256c4ac19035d6ada54c86e73ceb41bba0aa00`
  - size `5459886`
- HTTP:
  - `http://127.0.0.1:3333/updates/latest.json` 200，APK 200。
  - `http://100.66.1.82:3333/updates/latest.json` 200，返回 apkUrl host 为 `100.66.1.82`，APK 200。

## 2026-06-27 session drawer 新 session 按钮回归

### 现象
- portrait terminal session drawer 底部 `New Session` 按钮在真机上看起来无响应。

### 当前判断
- 按钮现在同时挂了 `pointerup` / `touchend` / `click`，还加了 600ms 去重。
- 这类多路事件 + 时间戳门禁在 Android WebView 上容易把真实点击链路吞掉。

### 修复方向
- 收敛成单一 `click` owner。
- `touch` 只保留给 drawer 滑动关闭，不再负责 new session 打开。

### 回归锁定
- 抽屉 add 按钮：`touchEnd` 不再触发打开，`click` 才是唯一语义 owner。

## 2026-06-27 Android IME 特殊键回归

### 现象
- 输入法/终端键盘里的 `Esc`、`Backspace` 等特殊键在真机上无效。

### 根因判断
- JS `TerminalPage` 已有 `ImeAnchor` 的 `input / backspace / key` 三条监听。
- shared renderer 也已能把 `Escape -> \x1b`、`Backspace -> \x7f`、`Delete -> \x1b[3~` 映射成终端序列。
- Native `ImeAnchorPlugin` 的 hardware key mapping 没锁住 `KEYCODE_DEL` / `KEYCODE_FORWARD_DEL`，部分输入法或硬件路径会把 Backspace/Delete 作为 keyCode 送到 `onKeyDown`，未进入 `backspace` listener。

### 修复方向
- native mapping 增加 `KEYCODE_DEL -> Backspace`、`KEYCODE_FORWARD_DEL -> Delete`。
- JS 回归锁住 `ImeAnchor key` payload 的 `Escape / Backspace / Delete / Ctrl+C` 都路由到当前 active session。

## 2026-06-22 升级包 404 现场复核（0.1.3.1872）

### 现场证据
- `android/update-dist/latest.json` 当前指向 `zterm-0.1.3.1872.apk`，`apkUrl` 为相对路径。
- `http://127.0.0.1:3333/updates/latest.json` 返回 200，manifest 与 `0.1.3.1872` 一致。
- `http://127.0.0.1:3333/updates/zterm-0.1.3.1872.apk` 返回 200。

### 结论
- 当前 daemon 更新服务侧没有 404。
- 若手机侧仍报 404，优先怀疑是旧客户端拿到了旧 manifest / 旧 apkUrl，而不是当前 daemon 路由本身失效。

## 2026-06-22 升级包 404 现场复核

### 当前核验
- `android/update-dist/latest.json` 与 `~/.wterm/updates/latest.json` 目前都指向 `zterm-0.1.3.1869.apk`
- 对应 APK 文件在两侧都存在
- `http://127.0.0.1:3333/updates/latest.json` 返回 200
- `http://127.0.0.1:3333/updates/zterm-0.1.3.1869.apk` 返回 200

### 结论
- 现阶段服务端升级包发布链路正常，当前 404 不是“包没落盘”导致
- 若设备端仍报 404，优先怀疑客户端持有旧 manifest / 旧 apkUrl，或请求到了别的更新源

## 2026-06-22 upgrade 404 follow-up
- 现象：manifest 命中，但安装侧仍可能拿旧 manifestUrl/旧 apkUrl。
- 当前修复：AppUpdatePlugin 失败信息增强，app-update-runtime 记录 lastInstallContext，App.tsx 移除 relay 二次派生残留。
- 验证：tsc clean；app-update-runtime 定向红测通过；verify-update-bundle 通过。

## 2026-06-22 升级包 404 真源：daemon 不得改写 manifest apkUrl
- 现场：`http://127.0.0.1:3333/updates/latest.json` 曾把 `apkUrl` 改成 `http://127.0.0.1:3333/updates/zterm-0.1.3.1871.apk`；手机拿到该绝对 URL 后会指向手机自己的回环地址，导致升级包下载 404。
- 真源：`android/src/server/terminal-http-runtime.ts::handleHttpRequest('/updates/latest.json')` 历史逻辑会把相对 apkUrl 重写成 `${origin}/updates/<apk>`。
- 修复：daemon 原样输出 build pipeline 写入的 manifest；唯一允许的 apkUrl 绝对化位置是 client `app-update-runtime.ts` 对 `manifestUrl` 执行 `new URL(payload.apkUrl, manifestUrl).toString()`。
- 红测：`android/src/server/server.http-truth.test.ts` 禁止 `/updates/latest.json` 路由再次出现 `${origin}/updates/<file>` 重写。
- 验证：`pnpm exec vitest run src/server/server.http-truth.test.ts` PASS（4/4）；`pnpm run type-check` PASS；`node scripts/verify-update-bundle.mjs` PASS；`bash scripts/zterm-daemon.sh restart` 已重新 stage `~/.wterm/daemon-runtime/server.cjs`；`curl http://127.0.0.1:3333/updates/latest.json` 返回相对 `apkUrl: "zterm-0.1.3.1871.apk"`；`curl -I http://127.0.0.1:3333/updates/zterm-0.1.3.1871.apk` 与 `curl -I http://100.66.1.82:3333/updates/zterm-0.1.3.1871.apk` 均为 200。

## 2026-06-22 optimization-2 阶段进展：head-request 首次 revision fanout 收口
- 现状核验：`terminal-message-runtime.ts` 的 `buffer-head-request` 仍经 `sendBufferHeadToSession(session, mirror)` 路由，但过去 `terminal-mirror-runtime.ts::sendBufferHeadToSession()` 是单 session 私有回包路径，8 个订阅者同时探头时会重复走 head fanout。
- 本轮修复：`android/src/server/terminal-mirror-runtime.ts`
  - 新增 mirror 级 `WeakMap<SessionMirror, { revision }>` head broadcast cache。

## 2026-06-24 图片/文件 picker 与 missing-session audit 二次收口（1896）

### 用户现场
- 1892/1893/1894 包在真机上“看起来没变化”：
  - 点击 `图片` / `文件` 没有任何弹窗
  - 缺失 session 灰显/一键关闭在现场不可见

### 本轮根因
- `TerminalQuickBar.tsx`
  - picker 仍依赖对完全隐藏 `display:none` 的 `input[type=file]` 做程序化 `click()`
  - Android WebView 下这类 input 很容易直接不弹系统 picker
  - 旧实现还把 `Keyboard.hide()` 混在同一路径里，真机上更难判断点击链是否丢失
- `remote-tab-audit.ts`
  - `fetchRemoteTmuxSessionNamesByOwner()` 返回空数组时，历史逻辑仍会把空数组当成远端真相去 prune
  - 这会让“远端返回未知/失败”错误投影成“session 不存在”

### 本轮代码修复
- `android/src/components/terminal/TerminalQuickBar.tsx`
  - picker 入口改成同手势栈内直接触发：优先 `showPicker()`，否则 `input.click()`
  - 触发后再异步 `Keyboard.hide()`
  - 文件 input 从 `display:none` 改成“视觉隐藏但仍在文档流可触发”的样式
- `android/src/lib/remote-tab-audit.ts`
  - 远端结果为空数组时不再 prune，也不再把 tab 标成 missing

### 白盒 / 黑盒验证
- `cd android && pnpm exec vitest run src/components/terminal/TerminalQuickBar.test.tsx src/lib/remote-tab-audit.test.ts src/pages/TerminalPage.real-quickbar-split.test.tsx src/pages/ConnectionsPage.test.tsx`
  - `PASS (78) FAIL (0)`
- `cd android && pnpm run type-check`
  - PASS
- `cd android && ./scripts/build-android-debug.sh`
  - PASS
  - build number: `1896`

### 升级链路证据
- `android/update-dist/latest.json` 与 `~/.zterm/updates/latest.json` 都指向 `zterm-0.1.3.1896.apk`
- `android/update-dist/zterm-0.1.3.1896.apk`
- `android/release-dist/zterm-0.1.3.1896.apk`
- `~/.zterm/updates/zterm-0.1.3.1896.apk`
- `curl http://127.0.0.1:3333/updates/latest.json`
  - 返回 `versionName=0.1.3.1896`
- `curl -I http://127.0.0.1:3333/updates/zterm-0.1.3.1896.apk`
  - `HTTP/1.1 200 OK`

### 仍待真机确认
- 自动回归已覆盖“真实 TerminalPage -> QuickBar -> 文件输入 -> onImagePaste/onFileAttach”黑盒链路
- 但是否完全命中 Jason 手上的那台 Android WebView 行为，仍需 Jason 用 1896 包现场点一次确认

## 2026-06-23 copy 现场复核

### 现象
- Jason 现场反馈：复制功能在真机上仍不可用。

### 当前确认
- JS copy-mode 链路仍在：
  - `TerminalView.tsx` 在 `copyModeActive` 下仍注册 row 级 `onTouchStart/onPointerDown` 长按计时，420ms 后调用 `onLongPressRow(...)`。
  - `useTerminalPageCopyRuntime.ts` 仍会把选区文本写入 `DeviceClipboardPlugin` / `navigator.clipboard`。
- 现有 jsdom 红测全绿，但这些测试不覆盖 Android 原生 `WebView` 的长按边界。

### 新怀疑根因
- `android/native/android/app/src/main/java/com/zterm/android/MainActivity.java` 之前对整个 `WebView` 设置了 `setOnLongClickListener(v -> true)`。
- 这会在原生边界吞掉真实设备上的长按，导致系统菜单被禁用的同时，DOM copy-mode 长按也可能收不到。

### 本轮处理
- 移除 `MainActivity` 对整个 `WebView` 的全局 long-click consume，改回只保留滚动条 / overscroll 配置。
- copy-mode 的"禁系统菜单"继续留在 DOM/React 层做，不在 native WebView 边界全局吞事件。

## 2026-06-23 copy 现场复核二：震动但无菜单

### 现象
- 1882 版本：启用 copy mode 后长按有震动，但菜单不弹出。

### 根因
- `setOnLongClickListener(v -> true)` 虽然禁了系统菜单，但 Android WebView 仍触发原生长按 haptic + touch 拦截，JS 的 `onTouchStart` 收不到完整 touch 序列，420ms timer 无法正常 fire。

### 修复
- `MainActivity.java`: 改为 `wv.setLongClickable(false)`。
  - 不再触发原生长按 haptic / 选择手柄。
  - touch 事件完整传给 DOM，JS copy-mode `startCopyLongPressTouch` 可以正常启动 420ms timer → `onLongPressRow` → 菜单弹出。

### 验证
- `cd android && npx tsc --noEmit` PASS
- `cd android && pnpm run test:terminal:contracts` PASS (566/566)
- `./scripts/build-android-debug.sh` PASS
- APK: `zterm-0.1.3.1885` (versionCode `1031885`)
- 缺口：Jason 现场复测长按菜单是否弹出；真机震动应消失。
  - `sendBufferHeadToSession()` 改为：某 revision 第一次 head probe 先 `broadcastBufferHeadToSubscribers(mirror)`，同 revision 后续 probe 只回 requester，不再重复 fanout。
  - `broadcastBufferHeadToSubscribers()` 广播时写入 revision cache，后续 cursor/body 更新后的广播仍会刷新该 cache。
- 红测：
  - `android/src/server/terminal-mirror-runtime.test.ts`
  - 新增用例：同 revision 第一次 `sendBufferHeadToSession()` 要对两个 subscriber 都发 `buffer-head`；第二次同 revision probe 只回 requester。
- 验证：
  - `pnpm exec vitest run src/server/terminal-mirror-runtime.test.ts src/server/terminal-message-runtime.test.ts` PASS。
  - `pnpm run type-check` PASS。
  - `pnpm run test:terminal:contracts` PASS（566 tests）。
  - `bash scripts/zterm-daemon.sh restart` 已重新 stage 新 daemon runtime。
  - `mac/scripts/daemon-throughput-bench.ts --subs=8 --duration=10`：
    - aggregate `headProbes=28472`
    - baseline 文档记录修复前 `17428`
    - 当前总 probe 数已超过 objective 门槛 `24000`
  - `./scripts/build-android-debug.sh` PASS，升级包发布：
    - `android/update-dist/zterm-0.1.3.1872.apk`
    - `~/.wterm/updates/zterm-0.1.3.1872.apk`
    - `versionCode=1031872`
    - `sha256=738535420ee9c618a2aa25c637026b61ee29d5d28d7265c0be1d7836dd92bef8`

## 2026-06-22 session drawer 多机场景 + Android copy-mode 系统菜单
### session drawer 收口
- `TerminalSessionDrawerItem` 新增 `hostKey/hostLabel` 显式字段，drawer 内部不再隐式从 bridge 派生
- `TerminalPage.drawerSessions` 按 `bridgeHost:bridgePort` 注入 hostKey；hostLabel 优先取该 host 上 customName
- 单机场景：归入 `default` 分组，host rail 不显示
- 多机场景：host rail pill 切换，default 选中 active session 所在 host
- 排序：已打开 session 按 pane 顺序排前面，未打开 session 按名字排后面
- 红测：5/5 PASS（基础 + 多机 rail + 多机切换 + 单 host 无 rail + 顺序保持）
### Android 拷贝系统菜单拦截
- 根因：WebView `setOnLongClickListener` 未设置，Android 原生长按触发系统上下文菜单
- 修复：`MainActivity.onCreate` 设置 `webView.setOnLongClickListener(v -> true)` + `setLongClickable(true)`，由 JS copy-mode 完全接管长按
- 升级包：zterm-0.1.3.1882.apk，sha256=4f5745d1662ba844017f46f314d3541c0e1bcb6329e74b67d93378936651cd40
- HTTP 200，update channel 正常

## 2026-06-23 daemon 自启 + tmux socket 标准化

### 诊断结果
- **daemon 自启**：实际已正常工作。launchd plist 存在，`RunAtLoad=true`，进程在跑。误报。
- **tmux socket 标准化**：默认在 `/private/tmp/tmux-501/default`，系统重启清空。
- **重启后连不上**：daemon 在跑但 tmux server 没 auto-start。daemon 启动时不自动 `tmux start-server`。

### 改动
1. `terminal-control-runtime.ts`：
   - `cleanEnv()` 加 `TMUX_TMPDIR=~/.wterm/tmux/`
   - 新增 `resolveTmuxSocketDir()` 函数
   - 新增 `ensureTmuxServerRunning()` — 创建目录 + start-server + list-sessions
   - deps 新增可选 `tmuxSocketDir`
2. `server.ts`：
   - 传入 `tmuxSocketDir: join(WTERM_HOME_DIR, 'tmux')`
   - 创建 terminalControlRuntime 后立即调用 `ensureTmuxServerRunning()`

### 验证
- `npx tsc --noEmit` PASS
- `pnpm run test:terminal:contracts` 50 files / 566 tests PASS
- daemon restart 后 socket 路径变为 `~/.wterm/tmux/tmux-501/default`
- `listTmuxSessions()` 正确返回新路径下的 sessions
- daemon health endpoint 正常

### 剩余风险
- 现有 tmux sessions 在旧路径 `/private/tmp/tmux-501/` 上，不会被新 daemon 看到
- 用户需手动迁移旧 sessions 到新路径，或等待旧 tmux server 自然消亡

### 修正：tmux socket 策略
- **第一版错误**：强制设 `TMUX_TMPDIR=~/.wterm/tmux/` → daemon 重启后创建了新 server 在新路径，看不到用户已有 sessions（demo-shell, routecodex）
- **正确方案**：`ensureTmuxServerRunning()` 先检测已有 tmux server（不设 TMUX_TMPDIR）
  - 有 server → 复用，不设 TMUX_TMPDIR
  - 无 server → 创建标准化路径 ~/.wterm/tmux/，设 TMUX_TMPDIR
- 新增 `runTmuxWithEnv()` helper 用于检测阶段
- 新增 `detectedSocketDir` 模块级变���控制 cleanEnv 行为

## 2026-06-23 copy 现场复核三：1885 仍弹系统工具栏

### 现场
- 1885 启用 copy 后长按：系统"全选 / 剪切 / 复制 / 分享 / AI 写作"浮动工具栏仍弹出。
- 我自己的 JS copy menu 未出现。

### 根因复盘
- 1885 用 `setLongClickable(false)`：不阻止 WebView 触发文本 selection，Android 仍然进入 ActionMode。
- 1882 用 `setOnLongClickListener(v -> true)`：会阻止系统 ActionMode。
- 1889（本轮）回退到 1882 同款 native 配置：`setLongClickable(true)` + `setOnLongClickListener(v -> true)`。

### publish
- `zterm-0.1.3.1889` (versionCode `1031889`)
- sha256: `3bb0d14d69d082381b32f42b1697b9d341cef554390880cea6282855505dca7b`
- HTTP 200, daemon update channel ready

### 缺口
- Jason 现场复测长按是否弹 JS copy 菜单（4 颗按钮胶囊"设为起点 / 设为终点 / 复制 / 关闭"）。
- 如果 JS 菜单仍未出现，下一轮直接追 `useTerminalPageCopyRuntime.handleLongPressCopyRow` 和 `TerminalPageCopyMenu` 渲染分支。

## 2026-06-24 daemon 重启后 sessions 列表空 - 根因 + 修复

### 现象
- 系统重启后 daemon 自动启动（launchd），但客户端 ws list-sessions 返回 []
- daemon stderr: `failed to release tmux window-size ownership for demo: no server running on /Users/fanzhang/.zterm/tmux/tmux-501/default`
- 用户手动 `tmux list-sessions` 仍能看到 `demo`

### 根因链路
1. 用户登录后手动启 `tmux` → server 挂在 `/tmp/tmux-501/default`，session `demo`
2. launchd 重启后先于用户登录启动 daemon → 此时 `/tmp/` 下还没有 user tmux server
3. 旧 `ensureTmuxServerRunning()` 看到默认 socket 没 server → 走 `detectTmuxSocketDir()` → `~/.zterm/tmux` → `mkdir` → `TMUX_TMPDIR=~/.zterm/tmux` → `start-server`
4. tmux 3.6a 的 `start-server` 是"启动 server 但立刻退出 client"的命令。**没有 live session 时 server 也会跟着退出**。
5. 用户登录后手动 tmux 启了 `demo` → 出现在 `/tmp/tmux-501/default` socket
6. daemon 用 `TMUX_TMPDIR=~/.zterm/tmux` 找自己的 socket → 找不到 server（因为 start-server 后 server 进程被 abort 了）→ 每次都报 "no server running"
7. 用户和 daemon 用的是两个 socket，互相看不见

### 修复
1. `cleanEnv()` 移除 `TMUX_TMPDIR` 设置（避免 launchd 继承污染）
2. `detectTmuxSocketDir()` → `detectTmuxSocketPath()`，固定 socket 路径为 `~/.zterm/tmux/tmux.sock`（之前是目录）
3. `runTmux()` / `runTmuxAsync()` 强制 prepend `-S <socketPath>`，避开 `tmux-501` 子目录、跨用户隔离
4. `ensureTmuxServerRunning()` 改用 `new-session -d -s zterm-daemon-keepalive` 起一个 keepalive session，避免 tmux server 自动退出
5. `HIDDEN_TMUX_SESSIONS` 加 `zterm-daemon-keepalive`，避免暴露给客户端
6. launchd runner 加 `-u TMUX_TMPDIR`（防环境变量污染）

### 验证
- daemon 启动后 `tmux list-sessions -S ~/.zterm/tmux/tmux.sock` → 返回 keepalive
- 客户端 ws list-sessions → 过滤后空（user session `demo` 在另一个 socket，不在 daemon 控制内；用户需要通过 daemon 客户端新建 tab 才会出现在 daemon socket）

### 待办
- 用户手动启的 `demo` 不会被 daemon 看到。这是有意为之（daemon 不能接管 user-managed tmux server，否则会和用户 shell 抢 PTY）。文档需说明：用户应在 daemon 控制下打开 session，或用 `zterm attach <name>` 把 user session 迁移到 daemon socket

## 2026-06-24 APK upgrade path publish audit

### 当前真相
- `android/.build-meta.json` 已升到 `1891`
- `android/update-dist/latest.json`、`android/release-dist/latest.json`、`~/.zterm/updates/latest.json` 仍停在 `0.1.3.1890`
- build 失败点：`src/server/terminal-control-runtime.ts` 残留未使用 import `mkdirSync` / `join`

### 本轮动作
- 先删掉 TS6133 阻塞 import
- 然后重跑 `./scripts/build-android-debug.sh`
- 必须验证 `update-dist` / `release-dist` / `~/.zterm/updates` 三处 manifest 和 versioned APK 一致后，才能宣称新 APK 已进入升级路径

### 验证结果
- `./scripts/build-android-debug.sh` PASS
- `pnpm run test:terminal:regression:core` PASS
- `pnpm run test:terminal:contracts` PASS（50 files / 566 tests）
- `pnpm run test:common-user-flows` PASS（7 files / 85 tests）
- `pnpm run test:relay:smoke` PASS
- `android/update-dist/latest.json` / `android/release-dist/latest.json` / `~/.zterm/updates/latest.json` 已统一到：
  - `versionName=0.1.3.1892`
  - `versionCode=1031892`
  - `sha256=735d9ba8a263ac94d21ba64b604c7e4814eb8d8a2380e1ebe663cfb1020dac57`
  - `size=5473686`
- versioned APK 已落三处：
  - `android/update-dist/zterm-0.1.3.1892.apk`
  - `android/release-dist/zterm-0.1.3.1892.apk`
  - `~/.zterm/updates/zterm-0.1.3.1892.apk`
- `scripts/verify-update-bundle.mjs` 返回 `ok: true`
- `curl http://127.0.0.1:3333/updates/latest.json` 返回 `1892` manifest
- `curl -I http://127.0.0.1:3333/updates/zterm-0.1.3.1892.apk` 返回 `HTTP/1.1 200 OK`

## 2026-06-24 image/file picker regression + missing-session visibility

### 现象
- `1892`：QuickBar 点“图片/文件”后真机无任何 picker 弹出
- 缺失 session 的灰色状态和 `Close missing` 虽然代码在，但埋在 group 展开层，卡片主体默认直接 open，用户难以进入缺失态处理路径

### 根因
- `TerminalQuickBar.tsx` 在 Android native + keyboard visible 路径走了 `Keyboard.hide() -> setTimeout(350) -> input.click()`
- 这个延迟 click 已脱离用户手势上下文，Android WebView 会吞掉 file/image picker
- `ConnectionsPage.tsx` 对 missing session group 的 card body 仍绑定“直接 open”，不是“先进入缺失态 review”

### 修复
- 图片/文件 picker 改为：同一点击栈内立即 `input.click()`，键盘只异步 `Keyboard.hide()`，不再 `setTimeout(350)`
- missing session group card：
  - preview / accent 直接显示 `N missing`
  - card 主体点击优先展开 group，让灰色 session 和 `Close missing` 直接可见
  - action button 仍保留 `Open/Enter` 语义

### 验证
- `pnpm exec vitest run src/components/terminal/TerminalQuickBar.test.tsx src/pages/ConnectionsPage.test.tsx` PASS（68/68）
- 新增门禁：
  - native + keyboard visible 时，图片/文件按钮点击后必须立刻触发隐藏 file input 的 click，不允许依赖延时 timer
  - missing-session group card 必须在卡片级暴露 `1 missing`，点击卡片主体进入展开 review，而不是盲目 open
- `./scripts/build-android-debug.sh` PASS
- `pnpm run test:terminal:contracts` PASS（566/566）
- `pnpm run test:common-user-flows` PASS（86/86）
- `pnpm run test:relay:smoke` PASS
- 新 APK：
  - `android/update-dist/zterm-0.1.3.1893.apk`
  - `android/release-dist/zterm-0.1.3.1893.apk`
  - `~/.zterm/updates/zterm-0.1.3.1893.apk`
- 三处 manifest 一致：
  - `versionName=0.1.3.1893`
  - `versionCode=1031893`
  - `sha256=1bdcd1c434acd9400496aa4036090be89bc403008ee709dff6b1d3b5eabc84ca`
  - `size=5473918`
- `curl http://127.0.0.1:3333/updates/latest.json` 返回 `1893`
- `curl -I http://127.0.0.1:3333/updates/zterm-0.1.3.1893.apk` 返回 `HTTP/1.1 200 OK`

### 追加测试设计修正（白盒 + 黑盒）
- Jason 反馈：之前测试只验证“函数被调用”，不够，必须分白盒与黑盒
- 白盒：
  - `TerminalQuickBar.test.tsx`
  - native + keyboard visible 下，`图片/文件` 点击后必须**在 `Keyboard.hide()` resolve 之前**同步触发隐藏 input 的 `click()`
  - 这条门专门防 `setTimeout(...) -> input.click()` 这类脱离用户手势上下文的错误实现复活
- 黑盒：
  - `TerminalPage.real-quickbar-split.test.tsx`
  - 通过真实 `TerminalPage -> TerminalQuickBar` 路径点击 `图片/文件`，再用用户侧 `change(file)` 验证 `onImagePaste/onFileAttach` 真正收到目标 session 和文件
  - `ConnectionsPage.test.tsx`
  - 通过卡片主体点击验证 missing-session group 不再盲目 open，而是进入 review 展开态并暴露 `Close missing`
- 当前测试门结果：
  - `TerminalQuickBar.test.tsx + TerminalPage.real-quickbar-split.test.tsx + ConnectionsPage.test.tsx` PASS（72/72）
  - `pnpm run type-check` PASS

## 2026-06-25: TUI bottom lines not refreshing

### Symptom
TUI (vim/htop/etc) bottom input area (status line / command line) never refreshes.
Lines are rendered but content is permanently stale.

### Investigation done
- TerminalView.tsx → buildTerminalRenderFrame → buildTerminalRenderRows chain traced
- `followDemandAnchorEndIndex` = `bufferTailAnchorEndIndex` = `max(startIndex, bufferTailEndIndex || effectiveBufferEndIndex)`
- `followVisualBottomIndex = min(anchor, effectiveBufferEndIndex)`
- If `bufferTailEndIndex` is stale → `followVisualBottomIndex` stuck → bottom lines outside visible window
- `projectRenderBuffer` in session-render-gate.ts reuses rows via `rowsEqual` — if buffer revision doesn't change, stale rows persist
- `applyBufferSyncToSessionBuffer` in shared/terminal-buffer.ts: `bufferTailEndIndex` from `resolveAuthoritativeTailEndIndex` uses `max(current.bufferTailEndIndex, sparseWindow.endIndex)`
- `trimToCache` limits buffer window to `cacheLines` — could trim bottom if `bufferTailEndIndex` is wrong
- `renderEndOffset = min(totalRows, visibleStartOffset + viewportRows + overscan)` — if totalRows > bufferLines.length, render tries to extend beyond available data

### Hypothesis
Most likely: `bufferTailEndIndex` in the render buffer snapshot is stale/frozen, causing `followDemandAnchorEndIndex` to clamp `followVisualBottomIndex` below the actual buffer end. This means the renderer's visible window bottom doesn't reach the latest lines.

### Next steps
1. Add runtime debug logging to trace `bufferTailEndIndex` vs `effectiveBufferEndIndex` vs `followVisualBottomIndex` at runtime
2. Check if `bufferTailEndIndex` updates when TUI redraws in place (same line count, different content)
3. The fix is likely in `@zterm/shared` package — NOT in the Android app layer
4. Need to verify whether daemon sends updated `availableEndIndex` when content changes without scrolling

### Root cause hypothesis (refined)
The render buffer store uses `renderBuffersEqual()` to detect changes.
This checks `revision` first, then `rowsEqual` per-cell.
If daemon sends updated content for in-place TUI redraw, the chain SHOULD work.
BUT if daemon's `revision` field doesn't increment for in-place redraws, the render gate's
`projectRenderBuffer` might short-circuit row comparison and reuse old row references.
The `reusedRowMask` logic in `projectRenderBuffer` compares `rowsEqual(row, previousProjectedRow)`
where `row` is from `buffer.lines` (live buffer) and `previousProjectedRow` is from previous render projection.
If these are reference-equal (from previous clone), the row is marked reused and NOT re-cloned.

Key question: does the live buffer's `lines[offset]` get a NEW cell array reference when content changes in place?
If `applyBufferSyncToSessionBuffer` creates new cell arrays only when new payload data arrives,
but the payload's lines cover the same range, the cells SHOULD be new references.

Need runtime debug to confirm:
1. `session.render-gate.flush.inspect` → liveBuffer vs projected comparison
2. Whether `bufferTailEndIndex` advances when TUI redraws in place
3. Whether `effectiveBufferEndIndex` matches actual buffer content length

## 2026-06-25 current audit

- Current uncommitted changes are regression tests and notes for TUI bottom stale repaint, not a new copy-code patch.
- Copy-mode truth to keep: native WebView long-press is a two-gate problem; `setOnLongClickListener(v -> true)` only suppresses ActionMode, `setLongClickable(false)` is the gate that restores JS long-press delivery.

## 2026-06-27 copy coupling audit

- Repeated copy regressions came from cross-layer gesture ownership drifting into multiple places.
- Current cleanup direction: copy long-press constants/move threshold live in `terminal-copy-gesture.ts`; QuickBar shell event filtering lives in `terminal-quickbar-shell-guards.ts`; copy runtime owns selection state only.
- Removed `[CopyTrace]` console logs from runtime path; debug evidence should use structured overlay/log gates, not production console spam.

## 2026-06-27 session drawer New Session 再回归

### 重新确认
- drawer 到 `onOpenQuickTabPicker -> pickerMode='quick-tab'` 的调用链是通的，问题不在 `TerminalPage` / `App` 桥接层。
- 真机点击 `New Session` 的失败点更像是 Android WebView 下 `click` / `pointerup` 没有稳定穿透到这个 drawer 按钮。

### 修复
- `TerminalSessionDrawer` 底部按钮改成自身单一 `touchend` owner，并 `stopPropagation()` 截断父级 drawer 手势。
- 回归测试从 `click/pointerUp` 改为 `touchEnd`，锁 `TerminalSessionDrawer` 与 `TerminalPage.session-drawer` 两层。

### 已验证
- `pnpm exec vitest run src/components/terminal/TerminalSessionDrawer.test.tsx src/pages/TerminalPage.session-drawer.test.tsx --reporter=dot` PASS
- `pnpm exec tsc --noEmit` PASS

## 2026-06-27 session drawer 真机诊断变量 + picker 自动刷新

### 诊断变量
- `TerminalSessionDrawer` 新增只记录不改变语义的事件探针：`drawer:touchstart/touchend`、`add:touchstart/touchend/pointerdown/pointerup/click/callback`。
- `TerminalPage` 状态浮窗新增 `DR/EV/CB/PM`：
  - `DR`: drawer 是否打开
  - `EV`: 最近事件序号与名称
  - `CB`: drawer 回调数 / page open-picker 回调数
  - `PM`: App pickerMode
- Jason 可先打开“状态”浮窗，再点击 drawer 底部 `New Session`，截图对比点击前后定位事件是否进入、回调是否进入、pickerMode 是否变化。
- 2026-06-27 真机截图显示 `EV 4:drawer:touchstart`、没有 `add:*`，说明事件进入 drawer 容器但没有进入原 inner button；Jason 明确排除“遮挡导致不弹框”。正确方向不是继续猜 `click/pointer/touch`，而是把语义 owner 放到实际可命中的 footer 触达面，并把 capture target 打进状态浮窗。
- 修复：`TerminalSessionDrawer` 将 `terminal-session-drawer-add` 从内部 button 上移到整个 footer hit surface；footer 自身作为唯一 `touchend` owner 触发 `onOpenQuickTabPicker()`，同时保留 `cap:start/end:<target>` 与 `add:capstart/capend` 诊断。`bottomInsetPx` 只作为布局避让输入，不再作为根因结论。

### picker 行为
- session picker 打开后若已有明确 `bridgeHost + authToken`，自动刷新 tmux session，不再要求每次人工点 `Connect`。
- picker row 统一合并 open tabs，不再只在 quick-tab 模式合并，减少“daemon session 列表 + 已打开 tab 列表”双列表心智。
- daemon 成功枚举后，目标 owner 下未出现在远端 session 列表中的 open tab 自动用 `session-picker-remote-missing` 关闭。

### 已验证
- `pnpm exec vitest run src/components/terminal/TerminalSessionDrawer.test.tsx src/pages/TerminalPage.session-drawer.test.tsx src/components/tmux/tmux-session-picker-rows.test.ts --reporter=dot` PASS
- `pnpm exec tsc --noEmit` PASS
- `./scripts/build-android-debug.sh` PASS，发布 `0.1.3.1923`。
- Jason 真机安装验证：drawer 内 `New Session` 点击后 picker 已能弹出，修复生效。

## 2026-06-28 adaptive-phone 启动读取缺口

### 现象
- Settings 中已保存 `terminalWidthMode=adaptive-phone` 后，App 启动第一次进入 terminal 仍按 `mirror-fixed` 宽度连接/排版。
- 只有重新进入 Settings 并 save 一次后，排版才按手机屏幕宽度生效。

### 根因
- `packages/shared/src/react/use-bridge-settings-storage.ts` 初始 state 固定为 `DEFAULT_BRIDGE_SETTINGS`，其中 `terminalWidthMode` 默认是 `mirror-fixed`。
- localStorage 里的真实 `BridgeSettings` 只在 mount 后 `useEffect` 异步读取。
- SessionProvider / restore / connect 的首帧可能已经消费了默认 `mirror-fixed`，所以启动时没有把已保存的 `adaptive-phone` 带入运行态。

### 修复
- `useBridgeSettingsStorage` 改为 lazy initializer 同步读取 `localStorage[STORAGE_KEYS.BRIDGE_SETTINGS]` 并 `normalizeBridgeSettings()`，确保第一次 render 就拿到已保存的 `adaptive-phone`。
- 保留 effect 作为浏览器环境挂载后的同步校正，但不再依赖 effect 才得到首屏设置。

### 已验证
- `pnpm exec vitest run ../packages/shared/src/react/use-bridge-settings-storage.test.tsx src/hooks/useTerminalShellActions.test.tsx src/lib/terminal-width-mode-manager.test.ts --reporter=dot` PASS。
- `pnpm exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx --reporter=dot` PASS。
- `pnpm --dir android exec tsc --noEmit` PASS。
- 已知既有测试不一致：`android/src/lib/bridge-settings.test.ts` 期望 daemon config path 为 `~/.zterm/config.json`，但共享实现返回 `~/.wterm/config.json`；该失败不是本次 adaptive 启动读取改动引入。

## 2026-06-28 copy mode QuickBar 入口偶发不激活

### 现象
- Jason 反馈：拷贝功能仍不是每次都能激活。

### 根因判断
- copy mode 长按菜单链路已有回归锁住，问题更靠前：QuickBar 固定按钮 `tmux-copy` 只在 `click` 中调用 `onToggleCopyMode()`。
- Android WebView 工具栏按钮的 `click` 合成不稳定时，按下没有进入 copy active；长按 terminal row 后自然不会弹 copy menu。

### 修复
- `TerminalQuickBar` 为 `tmux-copy` 改成 press-owned armed + release commit：`pointerDown` / `touchStart` 只负责 armed，`pointerUp` / `touchEnd` 只提交一次 copy mode，`click` 只作兜底。
- 去掉按时间窗判断同一轮 press 的做法，避免长按或慢释放把 copy mode 误切回去。

### 已验证
- `pnpm exec vitest run src/components/terminal/TerminalQuickBar.test.tsx src/components/terminal/copy-longpress-e2e.test.tsx src/components/terminal/system-copy-state-machine.test.tsx src/components/terminal/system-copy-longpress-regression.test.tsx --reporter=dot` PASS。
- `pnpm --dir android exec tsc --noEmit` PASS。

## 2026-06-28 copy mode 激活后右滑抽屉与 copy 仍失效

### 现场
- Jason 真机截图显示版本 `0.1.3.1926`，状态浮窗 `CM OFF`，点击底部 `拷贝` 后仍无法进入 copy mode。
- 同一状态下右滑无法拉出 session drawer，需要退出 terminal 再进入。

### 根因
- 上一版把 `tmux-copy` 激活从 press start 改到 release commit，Android WebView 仍可能漏掉 `pointerUp/touchEnd`，导致按钮触达但 `copySelection.active` 没有打开。
- copy mode 行级长按入口在 `touchstart/pointerdown` 里 `stopPropagation()`，会阻断父级 `TerminalTabSwipeSurface` 收到右滑起点；一旦 copy 相关手势接管，session drawer 右滑入口会被一起卡住。

### 修复
- `TerminalQuickBar` 改为 press start 立即触发 copy mode，并用显式 press sequence 去重：后续 `touchStart/pointerDown/touchEnd/pointerUp/click` 只消费，不再二次 toggle。
- `TerminalView` copy 行级长按不再 `preventDefault/stopPropagation`；只启动/cancel copy long-press timer，让父级 swipe surface 继续拥有右滑抽屉入口。

### 已验证
- `pnpm exec vitest run src/components/terminal/TerminalQuickBar.test.tsx src/components/TerminalView.test.tsx src/components/terminal/TerminalTabSwipeSurface.test.tsx src/components/terminal/copy-longpress-e2e.test.tsx src/components/terminal/system-copy-state-machine.test.tsx src/components/terminal/system-copy-longpress-regression.test.tsx src/pages/TerminalPage.session-drawer.test.tsx --reporter=dot` PASS（79/79）。
- `pnpm exec tsc --noEmit` PASS。
