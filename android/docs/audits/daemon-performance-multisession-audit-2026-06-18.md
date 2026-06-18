# daemon 性能 / 多 session 切换风险审计

- 审计对象：`android/src/server/server.ts` + `terminal-mirror-runtime.ts` + `terminal-control-runtime.ts` + `terminal-message-runtime.ts` + `terminal-runtime.ts` + `terminal-performance-scheduler.ts` + `terminal-transport-runtime.ts` + `terminal-message-control-runtime.ts` + `terminal-runtime-types.ts`
- 运行态真源：`~/.wterm/daemon-runtime/server.cjs`（重启后 uptime 66935s，rss 249MB / heapUsed 41MB，6 mirrors 全部 ready，0 subscriber）
- 探测真源：`mac/scripts/daemon-throughput-bench.ts`（控制 transport 走 control ws，session 走 session ws）
- 审计人：codex
- 审计时间：2026-06-18

## 0. 探测真值（实际跑通的数据）

| 场景 | subs | duration | head/s | sync/s | head-avg/sub | errors |
|---|---|---|---|---|---|---|
| 4 subscribers | 4 | 9.4s | 15806 | 15801 | ~37200 / 9.4 = ~3955 | 0 |
| 8 subscribers | 8 | 9.3s | 17428 | 17418 | ~20250 / 9.3 = ~2177 | 0 |

观察：
- subs 从 4 → 8 总 head/s 几乎不增长（15806→17428），单 sub 平均几乎腰斩（3955→2177）。
- 这意味着 `buffer-head-request` 处理路径存在 N² 行为：每轮广播每 sub 都做 `findChangedIndexedRanges` → `buildBufferHeadPayload` → `JSON.stringify` → `ws.send`。

## 1. 真源结构（按代码还原）

### 1.1 进程级真源
- `sessions: Map<sessionId, TerminalSession>`
- `mirrors: Map<mirrorKey, SessionMirror>`（**按 sessionName 一对一**）
- `connections: Map<connectionId, DaemonTransportConnection>`（**物理 ws/rtc**）

### 1.2 一条主线的真实节点序列

输入：
```
ws.onmessage(text)
-> terminal-bridge-runtime.handleMessage
-> terminal-message-runtime.handleMessage
-> switch(message.type) -> 'input'
-> writeInputIfCurrent(connection, payload)
-> resolveCurrentSessionForInput(connection) // = sessions.get(connection.boundSessionId)
-> terminalRuntime.handleInput(session, data, shouldWrite)
-> mirrorRuntime.handleInput
-> enqueueLiveMirrorInput(sessionName, data, false, shouldWrite) // microtask batch
-> liveMirrorInputBatches.set(mirrorKey, items)
-> schedulePendingLiveMirrorInput -> queueMicrotask
-> flushPendingLiveMirrorInput
-> runTmuxAsync('send-keys') // serialized per mirror
```

输出（live tick）：
```
liveSyncTimer 触发 (33ms active / 120ms idle)
-> syncMirrorCanonicalBuffer(mirror)
-> if (mirror.flushPromise) return mirror.flushPromise // dedup ✓
-> captureMirrorAuthoritativeBufferFromTmux(mirror)
-> tmux capture-pane
-> canonicalize (WasmBridge)
-> mirrorCaptureSnapshotsEqual(currentMirror, snapshot) // ✓ 不稳定禁止 commit
-> mirrorBufferChanged(mirror, prevStartIndex, prevLines) // -> findChangedIndexedRanges
-> broadcastChangedRangesBufferSyncToSubscribers(mirror, changedRanges)
-> buildChangedRangesBufferSyncPayload(mirror, changedRanges)
-> for (sessionId of mirror.subscribers)
-> resolveMirrorLiveSyncDelayForSubscriber(mirror, sessionId, ...) // per-sub
-> sendMessage(session, buffer-sync)
```

## 2. 风险列表（按优先级）

### R1【P0】buffer-head-request 触发 N² 同步风暴
- 现象：客户端频繁 `buffer-head-request` 走独立 `sendBufferHeadToSession`，不走 `broadcastBufferHeadToSubscribers`。
- 真因：`terminal-message-runtime.ts` 第 257-263 行，`buffer-head-request` 直接 `sendBufferHeadToSession`，**每个 sub 各自触发一次 capture-pane**（因为 `sendBufferHeadToSession` 不读最新 mirror，可能被误以为仅是 metadata，但调用栈要回去看 `refreshMirrorHeadForSession` → `syncMirrorCanonicalBuffer` → capture）。即便只走 metadata，也存在 JSON.stringify + per-sub `ws.send`。
- 探测证据：8 subs 时 `head/s` ≈17428，等价于单 sub ~2177/s。4 subs 单 sub ~3955/s。下沉 ~45%。
- 修复方向：把 `buffer-head-request` 收口为 `broadcastBufferHeadToSubscribers`（每轮 capture 一次），并对所有 sub 共享同一份 `buffer-head` payload。
- 验证门：benchmarks/daemon-throughput-bench 单 sub head/s ≥ 3500，8 subs 总 head/s ≥ 24000。
- 锁定测试：`server.debug-truth`、`server.bridge-runtime-truth`、`terminal-mirror-runtime`。

### R2【P0】`sendBufferHeadToSession` vs `broadcastBufferHeadToSubscribers` 双写
- 现象：同一镜像头有两种 push 路径：单 session 主动查询用前者，所有 subscriber 收 head 用后者。两次 capture-pane、两次 `JSON.stringify`。
- 真因：`terminal-mirror-runtime.ts` 把 `buffer-head` push 拆成两条函数，内部对 mirror.head 没做“同 revision skip”。
- 修复方向：把 `sendBufferHeadToSession` 改为"先看本地 mirror 是否有未发的 head diff；若 sub 因 backpressure skip，再排队"，避免重复 capture。
- 锁定测试：扩 `terminal-mirror-runtime.test.ts`。

### R3【P0】transport-close 不清理 `liveMirrorInputBatches`
- 现象：`handleInput` 把 input 进 `liveMirrorInputBatches`，但 transport detach / `closeSession` / `destroyMirror` 都 **不清理对应 mirrorKey 的 batch map**。
- 真因：检索 `terminal-control-runtime.ts`：
- `closeSession` → `terminal-runtime.ts:194` 仅做 `sessions.delete(session.id)` + `detachMirrorSubscriber`。
- `destroyMirror` → `terminal-mirror-runtime.ts:281` 只清 mirror 字段，没碰 `liveMirrorInputBatches`。
- `detachSessionTransportOnly` 同上。
- 后果：transport close 后，stale `shouldWrite` 回调可能在 `flushPendingLiveMirrorInput` 里被判定 false 但仍占着 Map entry；新 attach 同 sessionName 时残留 batch 可能合批进 tmux。
- 修复方向：在 `destroyMirror` / `closeSession` / `detachSessionTransportOnly` 三处统一调 `liveMirrorInputBatches.delete(mirrorKey)`。
- 锁定测试：`terminal-control-runtime.input-queue.test.ts` 加反向测试：close session 后同 mirrorKey enqueue 必须新建 batch，原 items 不得 leak。

### R4【P1】`liveSyncTimer` 跨 mirror 单 setTimeout 链表无 dedup
- 现象：每个 mirror 各自持 `liveSyncTimer`，但 `setTimeout` 在 `idle` → `active` 转换时只 `clearTimeout(currentTimer)`，新 timer 期间没有 capture 完成屏障。
- 真因：`terminal-mirror-runtime.ts:566` 起 timer 后 await `syncMirrorCanonicalBuffer`，但 `flushInFlight = true` 时仍允许再 schedule（scheduler lane=`normal`）。
- 后果：mirror 在 busy capture 时持续 re-schedule，consecutive timers 排队；tmux busy 时光照放大 capture 频率。
- 修复方向：起 timer 前检查 `mirror.flushInFlight`，若 in-flight 直接不 schedule，等待 `.finally` 内重排。
- 锁定测试：`terminal-mirror-runtime.test.ts` 加 "flush in-flight 期间不再排新 timer"。

### R5【P1】`broadcastChangedRangesBufferSyncToSubscribers` 串行 `JSON.stringify` + 串行 `ws.send`
- 现象：每轮 N sub × 1 buffer-sync payload。`buildChangedRangesBufferSyncPayload` 在循环外只做一次（✓），但 `sendMessage` 内 `JSON.stringify` + `ws.send` 是循环内逐 sub 调。
- 真因：`sendMessage` 内部 `JSON.stringify(message)` 单条执行（N 次）。
- 后果：sub 数量大时 CPU 主要消耗在 stringify。
- 修复方向：`broadcastChangedRangesBufferSyncToSubscribers` 改：先 `JSON.stringify` 一次得文本，再 `for sub ws.send(text)`。需要重构 `sendMessage` 暴露 `sendText`。
- 锁定测试：新增 `buffer-sync-fanout.bench` 收 sub=8 时单轮 CPU < 5ms。

### R6【P1】`handleAdaptiveResize` 每次都 `resize-window` tmux
- 现象：客户端键盘弹起 / 旋转 / pinch 都发 `resize`，daemon 实际 `tmux resize-window` 触发 pane 重排。
- 真因：`reconcileMirrorAdaptiveWidth` → `deps.runTmux(['resize-window'...])`。
- 后果：多 pane 切 tab 时频繁触发 tmux window 重新布局，I/O 抖动。
- 修复方向：把 resize 改成节流（>=200ms debounce）+ 仅在 target 与当前 cols 差 ≥2 时调。
- 锁定测试：`mirror-geometry.test.ts` 模拟 50 Hz resize。

### R7【P2】`mirror.adaptiveCols` map 跨 sub 共写，`resize-window` 全局影响
- 现象：1 个 mirror 的多个 sub 里只要有 1 个 `adaptive-phone`，daemon 会调 tmux `resize-window -x`，**整个 tmux window 跟着变**，影响所有其它 sub。
- 真因：`reconcileMirrorAdaptiveWidth` 计算 `minCols` 后直接 `resize-window`，不分 per-sub viewport。
- 后果：多客户端 / 多 sub 共用同一 tmux session 时，窄屏 sub 会把宽屏 sub 也窄化。
- 修复方向：若 sub 数 > 1 且 width mode 不全相同，禁止全局 resize（SKILL 已经写 mirror-fixed 不允许改 daemon mirror，但 adaptive-phone 同样问题）；改为"只在 baseline 固定"或"按 minCols 截 buffer"。
- 锁定测试：`terminal-mirror-runtime.test.ts` 加 "multi-sub 不同 widthMode 时不 resize"。

### R8【P2】scratchBridge WasmBridge 单实例共享 + 同步 canonicalize
- 现象：`terminal-mirror-capture.ts:345` `mirror.scratchBridge ?? await WasmBridge.load()`。同一 mirror 共享一个 WasmBridge 实例；多 mirror 各自一份。
- 真因：每个 mirror 在第一次 capture 时 `await WasmBridge.load()`，无并发去重。
- 后果：6 mirror 同时启动会起 6 个 WasmBridge 实例 + 各自一次 WASM 编译，启动慢；运行时 canonicalize 是同步（`await canonicalizeCapturedMirrorLines`），多 mirror 串行调度。
- 修复方向：把 `WasmBridge.load()` 提到模块级 `let bridgePromise: Promise ` 缓存；canonicalize 改成 worker / off-thread。
- 锁定测试：bench `scratchBridge-load.bench` 6 mirror 并行加载 < 200ms。

### R9【P2】`flushPromise` 单 Promise dedup，但不阻塞新 schedule
- 现象：`syncMirrorCanonicalBuffer` 开头若 `mirror.flushPromise` 直接 return。但 `scheduleMirrorLiveSync(0)` 仍会进 `queueMicrotask`，在 capture 完成后立即触发下一次。
- 真因：捕获完成后 `flushInFlight=false`，scheduler 看到 lane `fast`，几乎零延迟起下一拍。
- 后果：tmux 端有频繁输出时 capture 链被 0-delay 排到死，CPU 跑满 capture-pane。
- 修复方向：`fast` lane 至少 `Math.max(FAST_LANE_DELAY_MS=16, lastCaptureDurationMs)`，避免无限 0-delay。
- 锁定测试：扩 `terminal-performance-scheduler.test.ts`。

### R10【P3】`detachSessionTransportOnly` 后 `mirror.adaptiveCols.delete(session.id)` 但 mirror 仍 schedule live sync 0
- 现象：detach → reconcileMirrorAdaptiveWidth → 可能 resize tmux；同时 `scheduleMirrorLiveSync(0)`。意味着 detach 也会触发 capture-pane。
- 真因：`terminal-runtime.ts:182` `mirrorRuntime.scheduleMirrorLiveSync(mirror, 0)` 在 detach 路径。
- 后果：客户端切 tab / 切 session 时触发 tmux 抖动。
- 修复方向：detach 后只 reconcile，不 schedule 0-delay live sync；让下次 `attachTmux` 顺路起 sync。
- 锁定测试：`terminal-runtime.test.ts` 加 "detach 不起 0-delay sync"。

### R11【P3】`console.log` / `console.debug` 无开关
- 现象：`handleDaemonServerListening` 永远打 `console.log`，`mirror.flush.inspect` 永远 `console.debug`。
- 真因：日志关闭只能靠 `process.env`。
- 后果：log 文件增长。`memoryGuardMaxRssBytes=2.5GB`。
- 修复方向：把 `daemonRuntimeDebug` 也接 `console.*`，按 enabled 控制。

### R12【P3】connection role/transportId 与 session.id 同 ID 持久绑定
- 现象：`createTransportBoundSession` 中 `session.id = connection.transportId`。意味着 **session 实体就是 transport**，一个 ws 重连会建新 session。
- 真因：真源是 `TerminalSession.id === TransportId`，在 `bindConnectionToSession` 中重写。
- 后果：网络抖动 → 重连 → 旧 session 删除 → mirror subscriber 减少 → `reconcileMirrorAdaptiveWidth` 触发 resize（多 sub 场景下抖动放大）。
- 修复方向：把 `session.id` 与 `transportId` 解耦；transport 重建时复用 `session.id`。这一步是核心改动，需独立 PR。

### R13【P3】input payload 缺少大小上限
- 现象：`writeInputIfCurrent` 直接把 ws text payload 当 input。若粘贴一段 10MB 文本，daemon 会 `await runTmuxAsync(['send-keys', ..., '-l', '--', payload])`，tmux 1MB 单次发送上限会被破。
- 真因：`terminal-message-runtime.ts` 没做 input length 校验。
- 修复方向：在 `enqueueLiveMirrorInput` 入口对 `payload` 长度设上限（>256KB 报错 input_too_large）。client 端做 chunking。
- 锁定测试：`terminal-message-runtime.test.ts`。

### R14【P3】`buffer-head-request` 触发同步 capture 不复用上轮结果
- 现象：客户端高频率 head 请求 → 每次都跑 `syncMirrorCanonicalBuffer` → 实际 tmux capture。
- 真因：head 请求不进 capture dedup；与 liveSyncTimer 拍不同。
- 修复方向：head 请求若最近 < 100ms 内已 capture，直接用现有 `mirror.revision / latestEndIndex / cursor` 返回，不重 capture。
- 锁定测试：`terminal-mirror-runtime.test.ts` 加 "head request within 100ms uses cached revision"。

## 3. 风险交叉 / 影响面

- R1+R5+R9 叠加 → tmux 端高输出时 daemon CPU 跑满；客户端感觉"输入慢"。
- R3+R12 叠加 → 重连风暴 + stale batch → tmux 收到旧 input。
- R6+R7+R10 叠加 → 切 tab 多 pane 时 tmux 频繁 resize → tmux 崩溃面（参考 `tmux-2026-04-23-070736.ips` 控制模式 attach 崩溃栈）。
- R8 叠加 → daemon 启动 / 重连风暴时 WASM 反复编译。

## 4. 推荐修复顺序

1. **R3**（防 stale input leak，安全性）
2. **R1 + R2**（head 同步风暴，性能热点）
3. **R5**（CPU stringify 收敛）
4. **R9**（0-delay fast lane 限速）
5. **R10**（detach 不再 0-delay sync）
6. **R6 + R7**（resize 收敛 + 多 sub 不互相影响）
7. **R4 + R14**（in-flight dedup + head cache）
8. **R8**（WASM 单例化）
9. **R11-R13**（运维 / 鲁棒性）

## 5. 验证矩阵

| 修复 | bench 真源 | 红测真源 | 通过标准 |
|---|---|---|---|
| R1+R2 | `daemon-throughput-bench` | `terminal-mirror-runtime.test.ts` | 8 subs 总 head/s ≥ 24000，单 sub ≥ 3000 |
| R3 | N/A | `terminal-control-runtime.input-queue.test.ts` 新增反向测试 | close 后 batch map 空 |
| R5 | `buffer-sync-fanout.bench` | 新建 | 8 subs 单轮 CPU < 5ms |
| R6+R7 | `resize-throttle.bench` | `mirror-geometry.test.ts` | 50 Hz resize 时 tmux resize 实际 ≤ 5/s |
| R9 | `lane-stress.bench` | `terminal-performance-scheduler.test.ts` | capture 连发时 CPU < 30% |
| R10 | N/A | `terminal-runtime.test.ts` | detach 后 liveSyncTimer == null 维持 ≥1 帧 |

## 6. 离线审计边界（用户必须在线确认的项）

- 真机四分屏输入延迟是否随 R1+R2 修复同步降低（依赖 100.127.23.27 装 1834+ 重测）。
- R6 节流是否在快速旋转场景引发首次 attach 时的 cols 偏差（需人工旋转 5 次观察）。
- R7 多客户端不同 widthMode 当前没有真机多人测试条件，留给后续 traversal relay 实测。
