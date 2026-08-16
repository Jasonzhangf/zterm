# Optimization: daemon head fanout N² 风暴 + input batch leak + resize 节流

## 目标
修复 daemon 端 3 个 P0 级性能/安全问题：head-request N² 广播、input batch 泄漏、resize/tmux 抖动。附带修复 0-delay fast lane 和 detach 同步风暴。

## 当前证据
- bench 实测：4 subs head/s=15806, 8 subs head/s=17428（单 sub 从 3955→2177 腰斩）
- R3: closeSession/destroyMirror 不清理 liveMirrorInputBatches → stale batch 可能泄漏
- R9: `scheduleMirrorLiveSync(0)` → capture 完成后立即排下一拍，无限循环

## 改动清单

### Change R3: liveMirrorInputBatches 在 close/destroy 时清理（P0-安全）
文件：`terminal-control-runtime.ts` + `terminal-mirror-runtime.ts` + `terminal-runtime.ts`
- 新增函数 `clearLiveMirrorInputBatch(mirrorKey: string)`
- 三处调用：`destroyMirror`、`closeSession`、`detachSessionTransportOnly`
- 效果：transport close 后残留 batch 不再可能写入 tmux

### Change R1+R2: head request 收口 + 共享 payload（P0-性能）
文件：`terminal-message-runtime.ts` + `terminal-mirror-runtime.ts`
- `buffer-head-request` 不直接 `sendBufferHeadToSession`，改为：
  1. 检查 mirror revision 与 session 上次 head revision
  2. 若 revision 未变 → 返回 cached head
  3. 若已变 → 用 `broadcastBufferHeadToSubscribers` 共享 payload
- `refreshMirrorHeadForSession` 只在 mirror 未 ready 或 session 首次 attached 时 capture
- 效果：head 请求 1× capture 服务 N sub，而非 N× capture 服务 N sub

### Change R5: buffer-sync broadcast 先串一次 JSON.stringify（P1-性能）
文件：`terminal-mirror-runtime.ts` + `terminal-transport-runtime.ts`
- `broadcastChangedRangesBufferSyncToSubscribers` 内先 `JSON.stringify` 一次得 text
- `broadcastChangedRangesBufferSyncRawText` 跳过 `sendMessage` 内二次 stringify
- 修改 `sendText` 暴露 bypass stringify：`ws.send(text)` 不二次 JSON.stringify
- 效果：CPU 从 O(N × stringify) → O(1 × stringify + N × send)

### Change R9: fast lane 添加 capture cost 下限（P2-性能）
文件：`terminal-performance-scheduler.ts`
- `fast` lane 当前 `delayMs = 16`
- 改：`fast` lane `delayMs = Math.min(16, Math.max(0, lastCaptureDurationMs))`
- 效果：capture 耗时 80ms 时，即使 lane=fast 也不低于 16ms，不再 0-delay 风暴

### Change R6+R7: resize 节流 + 多 sub widthMode 保护（P1-稳定性）
文件：`terminal-mirror-runtime.ts`
- `reconcileMirrorAdaptiveWidth` 增加 debounce timer
- sub 数 > 1 且 widthMode 不全为 `adaptive-phone` 时，忽略 `adaptive-phone` 请求
- 效果：50Hz resize 时 tmux resize 实际 ≤ 5/s；全局 minCols 不影响其他 sub

### Change R10: detach 不再 0-delay sync（P3-稳定性）
文件：`terminal-runtime.ts`
- `detachSessionTransportOnly` 中 `scheduleMirrorLiveSync(mirror, 0)` → 移除
- 改为：让 `attachTmux` 顺路起 sync
- 效果：切 tab 不再触发无意义 capture-pane

## 验证门禁

| Change | 测试 | 通过条件 |
|---|---|---|
| R3 | `terminal-control-runtime.input-queue.test.ts` 新增 | close 后 batch map 空 |
| R1+R2 | `daemon-throughput-bench` | 8 subs head/s ≥ 24000 |
| R5 | 手动 `buffer-sync-fanout` 验证 | CPU 单轮 < 5ms |
| R9 | `terminal-performance-scheduler.test.ts` 扩 | fast lane ≥ 16ms * |
| R6+R7 | `mirror-geometry.test.ts` | 50Hz resize → ≤ 5/s tmux resize |
| R10 | `terminal-runtime.test.ts` 扩 | detach 后 liveSyncTimer == null |

## 风险
- R1+R2 的 cached head 可能在 capture 失败时返回旧 revision（需额外 error path 检查）
- R5 的 `sendText` bypass 可能漏掉 session-level metadata（需确认 `sendMessage` 已有用于 input/schedule）

## DoD
- [ ] R3+R1+R2+R5+R9+R6+R7+R10 全部 apply_patch
- [ ] contracts PASS
- [ ] daemon throughput bench 8 subs head/s ≥ 24000
- [ ] daemon mirror lab PASS
- [ ] APK 交付到升级路径
- [ ] commit/push
