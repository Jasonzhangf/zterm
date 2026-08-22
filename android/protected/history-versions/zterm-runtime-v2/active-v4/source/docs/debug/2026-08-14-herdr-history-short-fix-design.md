# Fix Design Report

Design ID: `FD-20260814-HERDR-HISTORY-SHORT-01`

Date: 2026-08-14

Owner: `daemon.herdr_backend` / `resource.herdr_terminal_session`

Status: `APPROVED`

## Goal

让 Herdr session 的 zterm mirror 不再只有当前可见 24 行。修复后，Herdr
adapter 使用官方 `pane read recent` 的 tail history snapshot 作为 mirror
历史真源，一次性补齐可滚历史；Herdr 0.8.0 的官方上限是 1000 行，因此本次
目标锁为最近 1000 行，不伪造 3000 行。

## Confirmed Root Cause

当前 Herdr mirror 的 `bufferLines` 来自
`HerdrFrameCanonicalizer.apply()`。Herdr 官方 `terminal.frame` 是渲染差异帧，
长输出后 host scrollback 确实存在，但 frame stream 不会把旧行重放到 zterm
的 WasmBridge VT scrollback，`bridge.getScrollbackCount()` 实测保持 0。

真实证据：

- 400 行输出后 `pane get.scroll` 为
  `max_offset_from_bottom=378, offset_from_bottom=0, viewport_rows=24`，
  但 canonical snapshot 的 `absoluteRange` 仍是 `[0,24)`。
- `terminal.scroll up 1` 后收到新 frame，canonicalizer 仍只输出 24 行，
  只是可见窗口从 399/400 变为 398/399。
- 官方 `pane read --source recent --lines N` 是稳定的 tail history source：
  400 行输出返回 402 行；5000 行输出时 `--lines 4000/6000/10000` 都返回
  最近 1000 行；追加 4 行后窗口滑动 4 行且旧行保持。
- `pane read recent --format ansi --raw` 经现有
  `canonicalizeCapturedMirrorLines` 后，尾部 24 行与 canonicalizer visible
  tail 完全一致。

官方源码确认：`src/app/api_helpers.rs` 中
`let line_limit = lines.map(|lines| lines.min(1000) as usize);`，
默认 `recent_lines = 80`。因此 Herdr 0.8.0 能提供的历史上限是最近 1000 行。

结论：历史短不是 renderer/client sparse buffer 裁剪问题，是 Herdr adapter
只消费了 frame stream，没有把官方 `pane read recent` 的稳定历史快照接入
mirror。

## Design

1. `HerdrFrameCanonicalizer` 保留为 live frame / cursor / geometry /
   cursorKeysApp / alternateScreen 的 canonicalizer，不再作为 mirror history
   truth。
2. `herdr-backend-runtime.readSnapshot()` 改为 adapter-owned tail snapshot
   builder：
   - 先等待 live canonical frame，保证会话与 geometry 可用；
   - 调用
     `herdr pane read <paneId> --source recent --lines <min(maxMirrorLines,1000)> --format ansi --raw`；
   - 用现有 `normalizeCapturedLineBlock` + `canonicalizeCapturedMirrorLines`
     把官方 ANSI 快照转成 `TerminalCell[][]`；
   - 用 `pane get.scroll` 的 `maxOffsetFromBottom + viewportRows` 仅作为
     source total row count hint，用于 tail window 滑动计数，不作为 absolute
     line identity；
   - 每次 history refresh 必须重新读取 fresh `pane get` total；fresh read
     失败时拒绝发布本次快照，旧 history window 保持不变；
   - `canonicalizeCapturedMirrorLines` 的 await 结束后重新检查最新 canonical
     frame geometry；geometry 变化则按最新 geometry 重试，不能稳定时拒绝，
     禁止把旧宽度行发布到新 `cols/rows` 下；
   - immediate refresh 只在 confirmed host scroll state 或 geometry 发生
     transition 时触发；host 持续 scrolled 期间仍保持 1000ms 低频历史刷新，
     不按每个 metrics 帧重读 1000 行；
   - 维护 daemon-owned per-session `sourceEndIndex` / `bufferStartIndex`：
     首次取 `max(canonicalLines.length, totalRowsHint)`，之后只单调增长；
     `bufferStartIndex = sourceEndIndex - canonicalLines.length`；
   - `availableStartIndex = bufferStartIndex`，表示 Herdr 只能提供最近
     1000 行，不伪造更早历史；
   - cursor 继续来自 live canonicalizer：host 在底部时映射 absolute cursor，
     host 已滚动时显式 null；
   - `capabilityGaps` 显式包含 `herdr-history-limit-1000`。
3. 删除旧路径中把 canonicalizer 的 24 行 `absoluteRange` 直接当成 mirror
   range 的投影；若 `pane read` 不可用或返回空，必须显式失败，不得用旧
   mirror 或 frame-only 内容继续发布。
4. 大于 1000 行的历史属于上游 Herdr 能力缺口：官方 0.8.0 没有 offset /
   更大 lines / 完整 absolute snapshot contract。zterm 不本地滚动遍历
   scrollback，不拼接 frame，不降级到 tmux。

## Boundaries

Allowed:

- `android/src/server/herdr-backend-runtime.ts`
- `android/src/server/herdr-process-transport.ts`
- `android/src/server/herdr-frame-canonicalizer.ts`
- `android/src/server/canonical-buffer.ts` / `mirror-line-canonicalizer.ts`
  仅当需要下沉共享 tail-window helper
- 对应 focused tests、test design、feature/function/resource docs

Forbidden:

- client renderer / sparse buffer 补偿
- 用 `pane get.scroll` offset 推导 absolute line identity
- 用 `terminal.scroll` 循环或本地拼接伪造超过 1000 行的历史
- 任何 tmux / WezTerm fallback
- 修改 Herdr 官方 binary 或 config 来绕过上限

## Verification Contract

L1 red/green:

- 红测：长输出后旧 `mapHerdrCanonicalSnapshot` 只产出 24 行，且没有调用
  `pane read`。
- 绿测：`readSnapshot()` 调用
  `pane read --source recent --lines min(cache,1000) --format ansi --raw`，
  输出 402/1000 行 canonical buffer。
- `bufferStartIndex` 在最近 1000 行窗口保持时，随 source total row delta
  单调前进；旧行保留、新行追加、无 stale 行残留。
- 400 行输出：`availableStartIndex=0`；5000 行输出：
  `bufferStartIndex>0` 且 `availableStartIndex=bufferStartIndex`。
- host scrolled：cursor null；host bottom：absolute cursor 正确。
- `pane read` 失败/空：显式错误，不发布 frame-only 24 行 truth。
- 正测：fresh `pane get` 成功时才更新 bounded history；反测：`pane get`
  失败时刷新被拒绝，旧 `[bufferStartIndex, sourceEndIndex)` 不被新 tail
  覆盖。
- 正测：canonicalization 期间 geometry 变化会按新 geometry 重试；反测：
  连续变化超过重试上限时显式失败，不发布 stale-width rows。
- 正/反测：confirmed bottom 的 daemon-side metrics 允许 intervening live rows
  原地覆盖，但不推进 `sourceEndIndex`；confirmed scrolled 时不覆盖。
- 现有 canonicalizer frame validation / reconnect / resize gates 不回退。

L2:

- 真实 Herdr 0.8.0 `daemon:mirror:close-loop`：长输出后 `buffer-sync` 至少
  包含 400/1000 行，client 可以拉取更早 range；反向验证没有伪造绝对 index。

L3/L5:

- 批准后按项目 gate 补 Mac/Android 客户端与真机验证。

## Non-Goals

- 白字竖纹 / 字符间距：独立 renderer cell width measurement，单独设计。
- Herdr upstream scrollback limit / offset API：外部 contract gap。
- live 更新延迟与 pane-read 调度：见
  `android/docs/debug/2026-08-14-herdr-update-latency-fix-design.md`
  （设计 ID `FD-20260814-HERDR-UPDATE-LATENCY-01`）。

## Evidence

- `playground/herdr-history-short-20260814/probe-evidence.json`
- `playground/herdr-history-short-20260814/raw-frames-evidence.json`
- `playground/herdr-history-short-20260814/pane-read-evidence.json`
- `playground/herdr-history-short-20260814/pane-read-scale-evidence.json`
- `playground/herdr-history-short-20260814/pane-read-canonical-alignment-evidence.json`
- `playground/herdr-history-short-20260814/daemon-history-live-close-loop-evidence.json`
- 官方源码：`/tmp/herdr-source-20260814/src/app/api_helpers.rs`

## Implementation Lock

Implementation follows `docs/decisions/2026-08-14-herdr-history-live-latency-truth.md`.
