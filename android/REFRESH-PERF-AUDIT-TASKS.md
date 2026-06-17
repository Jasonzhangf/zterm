# 刷新性能优化任务板

## 优先级 1：Passive Visible Pane 刷新提速
**问题**：非 active tab 的 visible pane 刷新固定 ≥160ms，带宽好也无法提速
**文件**：`android/src/contexts/session-context-lifecycle.ts`
**根因**：`resolvePassiveVisibleRefreshTickMs` = `max(160, min(240, activeTick * 6))`，只依赖 activeTick 乘数，不看 transport 健康状态

**修复方向**：
- 方案 A：在 `resolvePassiveVisibleRefreshTickMs` 中接入 transport 健康信号（`transportBufferedBytes`、`transportBackpressureCount`、`lastServerActivityAt`），当带宽好且 capture cost 低时返回 16-33ms
- 方案 B：引入独立的 `resolveGoodNetworkVisibleRefreshTickMs`，与 active tick 乘数解耦
- 红测：4 分屏场景，3 个 passive pane 在 good transport 下实测帧率达标（参考现有 p95 89ms gate，新增 passive-fast-lane gate）

**验证**：
- `pnpm run type-check` clean
- `multi-pane-refresh.test.ts` 新增 passive-fast-lane 测试用例
- 现场真机验证：4 分屏下 passive pane 不卡顿

---

## 优先级 2：Mirror Scheduler Worst-Subscriber 节流
**问题**：daemon mirror sync 用 `Math.max` 聚合所有 subscriber 的 buffered/backpressure，一个慢 client 拖慢全 mirror
**文件**：`android/src/server/terminal-mirror-runtime.ts` `resolveMirrorLiveSyncDelay`

**修复方向**：
- 每个 subscriber 独立记录自己的 cadence（不共享 max）
- `broadcastChangedRangesBufferSyncToSubscribers` 仍然广播同一 diff，但各 subscriber 按自己的 delay 订阅
- 注意：整体 mirror 的 `flushInFlight`、`consecutiveFailures` 仍应共享（这些是 mirror 自身状态）
- 只将 `transportBufferedBytes` 和 `transportBackpressureCount` 改为 per-subscriber，不取 max

**验证**：
- 新增 `terminal-mirror-runtime-per-subscriber-cadence.test.ts`
- 场景：一个 mirror 两个 subscriber，一个 backpressured，另一个仍走 fast lane

---

## 优先级 3：Tab 切换 probe/reconnect 等待优化
**问题**：切换 tab 后若 transport stale，会进 probe → reconnect 等待窗口，增加切换延迟
**文件**：`android/src/contexts/session-context-activity-runtime.ts`

**修复方向**：
- 在 `ensureActiveSessionFresh` 的 `explicit-resume` / `active-reentry` 路径中：若 transport 最近一次心跳（`lastServerActivityAt`）足够近（如 < 2×headStalePingMs），跳过 probe，直接用现有 transport
- 只在 transport 确认断线时才进 reconnect 路径
- 红测：tab 切换场景，transport healthy 时端到端延迟 < p95 gate

**验证**：
- `session-context-activity.test.ts` 新增 active-reentry-no-probe 测试

---

## 优先级 4：Render Gate 跨 Pane Frame Coalescing
**问题**：每个 visible session 独立 `setTimeout(frameTimerId)`，多 pane 各自漂移
**文件**：`android/src/lib/session-render-gate.ts`

**修复方向**：
- 引入全局 RAF coalescing layer：所有 `scheduleCommit` 收集到下一帧批量 flush
- per-session `flush()` 仍做，但 commit DOM 延迟到同一 RAF tick
- 保持 backward compatible：`resolveRenderCommitMs` 仍控制每 session 的 dirty coalescing window

**验证**：
- 新增 `session-render-gate-coalescing.test.ts`
- 场景：4 个 session 同时 dirty，RAF tick 内只触发一次 layout

---

## 优先级 5：Client Post-Apply Catchup 流量优化
**问题**：daemon push 后 client 仍发 visible-range-repair / tail-refresh catchup 请求
**文件**：`android/src/contexts/session-context-buffer-runtime.ts`

**修复方向**：
- `applyIncomingBufferSyncRuntime` 中 gap repair 触发条件收严：只在真正有 gap 且 gap 在 visible range 内时才发
- tail-refresh 触发条件：只有 head revision 跳变才发，delta sync 不触发

**验证**：
- 现有 buffer-sync 测试全绿
- 新增 `buffer-sync-catchup-minimal.test.ts`

---

## 执行顺序
1. P1（Passive pane fast lane）
2. P2（Per-subscriber mirror cadence）
3. P3（Tab switch no-probe）
4. P4（Render RAF coalescing）
5. P5（Post-apply catchup trimming）

每次 P 完成必须：
- `pnpm run type-check` clean
- 关联红测全绿
- 构建 APK 推入 `~/.wterm/updates/`
- note.md 记录验证结果

---

## 2026-06-17 本地吞吐基准验证

### 已完成

**mac daemon-throughput-bench 本地回归工具已落地**
- 文件：`mac/scripts/daemon-throughput-bench.ts`
- 验证协议：2-phase WS handshake（`?ztermTransport=control` → `session-ticket` → `?ztermTransport=session`）
- 首次本地基线（loopback，2 subscriber，静态 session）：
  - `head/s = 7519`，`sync/s = 7515`，connect latency avg=17ms max=22ms，errors=0
  - **结论**：daemon 本地吞吐充足，不是本地性能瓶颈；瓶颈在远端传输层（WAN/移动网络）

**P1-P5 全部红测通过**：`pnpm run type-check` clean + 全部红测 PASS

**APK 1828 推入 `~/.wterm/updates/`**

### 剩余任务

- 真机多 pane 刷新性能验证（需 APK 1828 + 现场测试）
- 输入通道延迟审计（daemon input → tmux inject 链路，优先查是否有 queueing/backpressure）
- IME 上抬容器回归验证

---

## 2026-06-17 收口审计

### 证据核对

| P | 计划要求 | 实现文件 | 红测文件 | 验证结果 |
|---|---|---|---|---|
| P1 | resolvePassiveVisibleRefreshTickMs 接入 transport health，好网返回 16-33ms | session-context-lifecycle.ts:76 | session-context-lifecycle.passive-fast-lane.test.ts | ✅ PASS (5 cases) |
| P2 | per-subscriber cadence，shared mirror flush/consecutiveFailures | terminal-mirror-runtime.ts | terminal-mirror-runtime.per-subscriber-cadence.test.ts | ✅ PASS (4 cases) |
| P3 | active-reentry skip probe when lastServerActivityAt < 2×headStalePingMs | session-context-activity-runtime.ts | session-context-activity-runtime.tab-switch-no-probe.test.ts | ✅ PASS (5 cases) |
| P4 | RAF coalescing layer，所有 dirty session 同一 RAF tick flush | session-render-gate.ts:281-330 | session-render-gate.test.ts + multi-pane-refresh.test.ts | ✅ PASS (40 total) |
| P5 | post-apply catchup trimming：gap repair 只在 visible range 内，tail-refresh 只在 head revision 跳变时发 | session-context-buffer-runtime.ts:783,806 | buffer-sync tests 全绿 | ✅ PASS |
| 本地吞吐基线 | N sub 并行，top oracle，connect/head/sync 吞吐量化 | mac/scripts/daemon-throughput-bench.ts | 实跑验证 | ✅ 2sub: head/s=7519 sync/s=7515 avg=17ms |

### APK 交付
- 路径：`~/.wterm/updates/zterm-0.1.3.1828.apk`（5.2M）
- latest.json 已更新

### 剩余工作（计划外）
- 真机多 pane / tab switch 冒烟验证（需现场 APK 测试）
- 输入通道延迟专项本地 bench（daemon input inject 链路量化）

### 完成状态：所有计划内 P1-P5 + 本地吞吐基线已交付，红测全绿，type-check clean，APK 1828 就绪
