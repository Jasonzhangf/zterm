# 刷新性能优化实施计划

## 目标
多 session 切换最短时延；带宽充足时多 pane 帧率最大化。

## 优先级与验收标准

### P1 - Passive Visible Pane 刷新提速
- **文件**：`android/src/contexts/session-context-lifecycle.ts`
- **根因**：`resolvePassiveVisibleRefreshTickMs` 固定 ≥160ms，不看 transport 健康状态
- **修复**：`resolvePassiveVisibleRefreshTickMs` 接入 transport 健康信号（bufferedBytes/backpressure），带宽好时返回 16-33ms
- **红测**：`multi-pane-refresh.test.ts` 新增 passive-fast-lane 场景，4 分屏被动 pane 在 good transport 下帧率达标
- **验证**：`pnpm run type-check` clean；关联测试全绿；APK 推入 `~/.wterm/updates/`

### P2 - Mirror Scheduler Per-Subscriber Cadence
- **文件**：`android/src/server/terminal-mirror-runtime.ts` `resolveMirrorLiveSyncDelay`
- **根因**：`Math.max(transportBufferedBytes/backpressure)` 取所有 subscriber 的最差值，一个慢 client 拖全 mirror
- **修复**：subscriber 的 buffered/backpressure 改为 per-subscriber 独立记录；mirror 自身的 `flushInFlight`/`consecutiveFailures` 仍共享
- **红测**：新增 `terminal-mirror-runtime-per-subscriber-cadence.test.ts`
- **验证**：同上

### P3 - Tab Switch No-Probe
- **文件**：`android/src/contexts/session-context-activity-runtime.ts`
- **根因**：tab 切换后 transport stale 时进 probe → reconnect 等待窗口
- **修复**：`ensureActiveSessionFresh` 的 active-reentry/explicit-resume 路径：若 `lastServerActivityAt` < 2×headStalePingMs，跳过 probe
- **红测**：`session-context-activity.test.ts` 新增 active-reentry-no-probe
- **验证**：同上

### P4 - Render Gate RAF Coalescing
- **文件**：`android/src/lib/session-render-gate.ts`
- **根因**：每个 session 独立 `setTimeout`，多 pane 各自漂移
- **修复**：引入全局 RAF coalescing layer，所有 `scheduleCommit` 延迟到同一 RAF tick 批量 flush
- **红测**：新增 `session-render-gate-coalescing.test.ts`
- **验证**：同上

### P5 - Post-Apply Catchup Trimming
- **文件**：`android/src/contexts/session-context-buffer-runtime.ts`
- **根因**：daemon push 后 client 仍发不必要的 visible-range-repair / tail-refresh
- **修复**：gap repair 只在 gap 在 visible range 内时发；tail-refresh 只在 head revision 跳变时发
- **验证**：现有 buffer-sync 测试全绿

## 执行顺序
P1 → P2 → P3 → P4 → P5

## 每次 P 完成后必须
1. `pnpm run type-check` clean
2. 关联红测全绿
3. 构建 APK 推入 `~/.wterm/updates/`
4. 更新 `android/note.md`
5. git commit

## 真源文件引用
- `android/src/contexts/session-context-lifecycle.ts`
- `android/src/server/terminal-mirror-runtime.ts`
- `android/src/server/terminal-performance-scheduler.ts`
- `android/src/contexts/session-context-activity-runtime.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/contexts/session-context-buffer-runtime.ts`
- `android/src/contexts/multi-pane-refresh.test.ts`
- `android/src/server/terminal-performance-scheduler.test.ts`
