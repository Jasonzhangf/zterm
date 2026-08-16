# Fix Design Report

Design ID: `FD-20260814-HERDR-UPDATE-LATENCY-01`

Date: 2026-08-14

Owner: `daemon.herdr_backend` + `daemon.mirror_runtime`

Status: `APPROVED`

## Goal

消除 Herdr 外部输出进入 zterm mirror 时的最长约 500ms 延迟，同时避免
`FD-20260814-HERDR-HISTORY-SHORT-01` 的 1000 行历史快照变成每 33ms 的
全量重读。修复后 Herdr live 更新保持 frame 级实时，历史窗口低频刷新。

## Confirmed Root Cause

1. `TerminalMirrorRuntime` 的 quiet capture backoff 会把无变化镜像从
   `120ms -> 240ms -> 480ms -> 500ms` 拉长。Herdr adapter 的
   `onCanonicalFrame` 只更新 `session.latestSnapshot`，没有唤醒
   `scheduleMirrorLiveSync`，因此静默后的外部新输出要等下一次轮询才被
   `readSnapshot()` 读到并广播。
2. `herdr-process-transport` 对每个 `terminal.frame` 同步执行
   `pane get`。隔离 Herdr 0.8.0 probe 实测该 CLI 单次 4-5ms；在持续
   输出时 frame 到达本身约 16-24ms（约 60fps），同步 spawn 不是主延迟，
   但会成比例增加事件循环阻塞，不能放进高吞吐路径。
3. 若直接把历史修复的 `pane read --lines 1000` 放进现有 33ms capture
   loop，`lastCaptureDurationMs + lastCanonicalizeDurationMs` 会进入
   `capture-over-budget`，反而把更新拉慢。历史快照和 live frame 必须分
   层。

Evidence:

- `playground/herdr-update-latency-20260814/update-latency-evidence.json`：
  no-metrics 25 个 frame interval mean 19.2ms，with-metrics 26 个 frame
  interval mean 18.8ms；`pane get` mean 4.5ms。
- `playground/herdr-history-short-20260814/daemon-history-live-close-loop-evidence.json`：
  quiet idle 713ms 后首帧到 `buffer-sync` 为 20ms，full history
  `[0,403)` 可一次拉取。
- 代码路径：`terminal-mirror-runtime.ts` 的
  `QUIET_CAPTURE_MAX_DELAY_MS = 500` 与 `resolvePostFlushSyncDelayMs`；
  `herdr-backend-runtime.ts` 的 `onCanonicalFrame` 只赋值
  `session.latestSnapshot`。
- 历史根因与 1000 行上限见
  `android/docs/debug/2026-08-14-herdr-history-short-fix-design.md`。

## Design

1. `HerdrBackendRuntimeOptions` 增加可选的 live activity handler：
   `onLiveActivity?: (sessionName: string) => void`。`ensureAdapter` 的
   `onCanonicalFrame` 在保存最新 snapshot 后调用它，不再只做被动缓存。
2. `server.ts` 在 mirror runtime 创建后注入该 handler：通过
   `getMirrorKey(sessionName, 'herdr')` 找到对应 mirror，并调用
   `terminalRuntime.scheduleMirrorLiveSync(mirror, 0)`。Mirror 没有 body
   subscriber 时由现有 `scheduleMirrorLiveSync` 直接停止，不产生后台
   空转。
3. Mirror 调度器把“外部 live event 唤醒”和“quiet backoff”区分开：
   - frame event 唤醒使用 explicit-immediate 路径；
   - 无新 frame 时仍按 quiet backoff 退避，不允许自旋；
   - `syncMirrorCanonicalBuffer` 检测到内容变化后继续走 active
     `33ms` lane。
4. Herdr adapter 的 mirror snapshot 改为 daemon-owned merged buffer：
   - history 真源来自官方 `pane read --source recent --lines
     min(terminalCacheLines,1000) --format ansi --raw`，低频刷新
     （默认 1000ms；attach、host scroll、geometry change 时立即）；
   - live tail 真源来自 `HerdrFrameCanonicalizer` 的可见 rows；
   - host 在底部且 geometry 匹配时，用 live rows 替换 merged buffer 的
     尾部，保证 16-24ms 的 frame 级实时；
   - host 已滚动时 live rows 不替换尾部，cursor 显式 null，等待下一次
     低频 history 刷新；
   - history refresh 本身必须拿到 fresh `pane get` total 才更新
     `sourceEndIndex`；fresh metrics 失败则拒绝本次刷新，旧 window 不变化；
   - history canonicalization await 后必须重新核对最新 frame geometry；
     geometry 变化按最新 geometry 重试，不能稳定时拒绝 stale-width snapshot；
   - immediate history refresh 只在 host scroll / geometry transition 时触发；
     host 持续 scrolled 期间保留 1000ms 低频历史刷新，不按 100ms metrics
     样本重复全量 `pane read`；
   - daemon 侧 confirmed bottom metrics 允许两次 `pane get` 之间的 live rows
     原地 overlay，但不推进 `sourceEndIndex`；confirmed scrolled 时不 overlay；
   - `bufferStartIndex / availableStartIndex` 仍只表示最近
     `min(...,1000)` 行窗口，不伪造更早历史。
5. `pane get` scroll metrics 从每帧同步读取改为低频节流（默认
   100ms），只在 live activity 期间采样；frame 本身不因 metrics 失败
   被丢弃。

## Boundaries

Allowed:

- `android/src/server/herdr-backend-runtime.ts`
- `android/src/server/herdr-process-transport.ts`
- `android/src/server/herdr-frame-canonicalizer.ts`
- `android/src/server/terminal-mirror-runtime.ts` 的 live wake 边
- `android/src/server/server.ts` 的 handler 注入
- 对应 tests、test design、feature/function/resource docs

Forbidden:

- 把 client renderer / sparse buffer 当作 live 更新 owner
- 在 daemon 中拼接或伪造超过 Herdr 官方 1000 行上限的历史
- 用 tmux / WezTerm fallback 读取 Herdr
- 让 `pane read` 1000 行进入每 33ms capture loop
- 让 60fps frame event 在没有内容变化时驱动 busy poll

## Verification Contract

L1 red/green:

- 红测：quiet backoff 后外部 canonical frame 到达，`onCanonicalFrame`
  没有触发 mirror wake。
- 绿测：`onLiveActivity` 只对匹配 Herdr mirror 调
  `scheduleMirrorLiveSync(0)`；无 body subscriber 时不启动 timer。
- 正测：持续 frame 时 live tail 每帧替换、history 不参与 33ms loop。
- 反测：无新 frame 时 quiet backoff 恢复，不产生自旋；host scrolled
  时 live tail 不覆盖历史窗口。
- 正/反测：history refresh 仅在 fresh `pane get` 成功时更新
  `sourceEndIndex`；metrics 失败保持旧 bounded window。
- 正/反测：canonicalization 期间 geometry 变化会重试并采用最新 geometry；
  无法稳定时拒绝 stale-width history。
- 正/反测：immediate history refresh 只在 host scroll / geometry transition
  触发；持续 scrolled 的 metrics-bearing frames 不重读 1000 行。
- 正/反测：confirmed bottom 的 daemon-side metrics 支持 intervening live
  overlay 且不推进 `sourceEndIndex`；confirmed scrolled 不 overlay。
- 1000 行 history 刷新期间，新 frame 仍能更新 live tail 且不会阻塞
  WebSocket 广播。
- 现有 canonicalizer frame validation / reconnect / resize 不回退。

L2:

- 真实 Herdr 0.8.0 + daemon mirror close-loop：外部持续输出从 frame 到
  `buffer-sync` 的端到端延迟进入 active lane，quiet 后首帧不再等
  500ms。

L3/L5:

- 批准后按项目 gate 完成 Mac/Android 客户端与真机验证。

## Non-Goals

- Herdr upstream 1000 行 history 上限：外部 contract gap。
- tmux / WezTerm quiet backoff 行为：本轮不动。
- renderer cell width / 白字竖纹：独立设计。

## Related Design

- `FD-20260814-HERDR-HISTORY-SHORT-01`：历史窗口结构修复。

## Implementation Lock

Implementation follows `docs/decisions/2026-08-14-herdr-history-live-latency-truth.md`.
