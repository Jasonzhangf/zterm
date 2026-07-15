# Daemon / Client Transport Performance Plan

## 1. 目标与验收标准

目标：把 terminal daemon 与客户端传输链路改成可验证的性能闭环，满足“带宽好时刷新快，带宽差时刷新慢”，并解决多 pane 在好带宽下仍刷新慢的问题。

验收标准：
- 每个审计问题都有先失败的红测，修复后转绿。
- daemon push scheduler 使用明确的 transport / capture / backpressure truth，不再只靠固定 33ms / 120ms timer。
- 多 pane 场景下有性能回归门禁，能量化 `capture -> send -> client rx -> buffer apply -> render commit` 延迟。
- 弱网 / backpressure 下会显式降频或合并，不堆积旧 payload。
- 好网 / 空队列 / 小 payload 下允许低延迟刷新，不被无意义固定慢路径限制。
- 不破坏 terminal 四层边界：daemon 不持有 client active / follow / reading / viewport 语义。
- 完成后通过验证、提交并推送。

## 2. 范围与边界

In scope：
- daemon mirror live sync 调度与性能观测。
- daemon transport send backpressure / queue truth。
- client transport quality / cadence / render commit gate。
- 多 pane latency 红测与回归门禁。
- 文档、skill、测试、实现、验证、commit、push。
- APK 构建与升级路径交付，供真机按升级包验证。

Out of scope：
- 不改 terminal wire payload 的语义内容；不得裁剪真实 payload 达成提速。
- 不把 runtime 源码复制进 app repo。
- 不让 daemon 读取 client active tab / follow / reading / visible range。
- 不做 fallback / 双路径补偿 / 静默吞错。
- 不发布 daemon/npm/release 资产；本任务只交付 Android APK 到升级路径。

## 3. 设计原则

- 先测试真源，再实现：每个问题先补能失败的红测。
- 唯一真源：transport quality、capture cost、send backpressure、render cadence 都要有明确 owner。
- daemon 只允许知道 transport 物理事实和 mirror 事实；不能知道客户端 UI 状态。
- 性能优化不能改变请求/响应语义，不能通过丢 payload、裁剪真实行、吞错误实现。
- 好网 fast lane 与弱网 slow lane 都必须有测试证明。
- 测量优先于调参：先能定位，再优化。

## 4. 审计问题与红测矩阵

### 问题 1：daemon live push 没有带宽/队列自适应

证据：
- `android/src/server/terminal-mirror-runtime.ts` 固定 `MIRROR_LIVE_SYNC_ACTIVE_MS=33`、`MIRROR_LIVE_SYNC_IDLE_MS=120`。
- `resolveMirrorLiveSyncDelay` 只看最近 flush 和 failure backoff。

红测：
- 新增 daemon scheduler 单测：当 transport quality 为 good、send 队列为空、capture cost 低时，下一轮 delay 应进入 fast lane。
- 新增弱网/背压单测：当 transport `bufferedAmount` 或 send backlog 超阈值时，下一轮 delay 应降频。
- 新增边界红测：scheduler 输入不得包含 client active tab / follow / reading / visible range。

预期实现：
- 新增 daemon-side transport quality / mirror scheduler helper，输入只包含 physical transport + mirror capture metrics。
- live sync delay 由 scheduler 产出，而不是散落在 runtime 里硬编码。

### 问题 2：多 pane capture 使用同步 tmux 调用，容易阻塞 Node event loop

证据：
- `android/src/server/terminal-control-runtime.ts` 的 `runTmux` 使用 `spawnSync`。
- `terminal-mirror-capture.ts` 每次 capture 读取 metrics、cursor、`capture-pane` 并 canonicalize。

红测：
- 新增多 mirror scheduler 单测：多个 ready mirrors 同时调度时，不允许同一 mirror 重入 capture；capture 超预算时必须推迟下一轮。
- 新增 slow capture 红测：模拟某 mirror capture duration 超阈值，其他 mirror 不能被永久饿死。
- 新增性能 trace 单测：每次 capture 必须记录 start/end/duration/canonicalize duration。

预期实现：
- 先保留现有 single-capture truth，不急于改 async tmux。
- 增加 capture duration truth 与 fair scheduling / over-budget backoff。
- 若后续改 async/worker，必须另开 migration plan 与 ordering 红测。

### 问题 3：server send path 没有 backpressure / drain 策略

证据：
- `terminal-transport-runtime.ts` 的 send path 只判断 `OPEN` 并 `sendText(JSON.stringify(message))`。
- 不读取 ws / rtc buffered bytes，也没有 send queue 状态。

红测：
- WebSocket transport 红测：`bufferedAmount` 高时，scheduler 必须收到 backpressure truth。
- RTC transport 红测：data channel buffered amount 必须进入同一抽象。
- Send path 红测：发送失败或非 OPEN 必须显式暴露/计数，不得静默当成功。
- Queue 红测：backpressure 下不允许无限堆积 buffer-sync；必须合并或降频，且不得改变 payload 语义。

预期实现：
- 抽象 `TerminalTransportBackpressureSnapshot`。
- send path 记录 bytes、buffered amount、send error、lastSendAt。
- scheduler 消费 backpressure truth 决定 delay / coalesce。

### 问题 4：client producer cadence 与 renderer commit cadence 必须分离

证据：
- `mobile-config.ts` 只允许描述 head / tail refresh / stale ping / pull / reading sync 等 producer cadence。
- `session-render-gate.ts` 已废止 `renderCommitMs`，只允许 RAF coalescing，并在 RAF flush 时读取当前 live buffer。
- `session-context-buffer-runtime.ts` sync debounce 固定 33ms。

红测：
- 好网红测：低 RTT / 空队列 / 小 payload 下 producer cadence 可进入 fast lane。
- renderer 红测：同一帧内旧 buffer 先 schedule，RAF 前 live buffer 更新后，只发布最新 live buffer，不发布旧帧。
- 弱网红测：高 RTT / saveData / 2g / backpressure 下主动 head/pull 降频。
- 输入路径红测：用户输入后首个 pending tail refresh 不被普通 debounce 吃掉。
- 多 pane 红测：visible live panes 都能接收 live payload，但 hidden inactive 仍 preparse drop。

预期实现：
- client cadence resolver 增加 runtime transport quality 输入，而不是只读 `navigator.connection`。
- render gate 支持 fast/normal/slow lane。
- buffer sync debounce 使用语义去重 + cadence，不引入 request storm。

### 问题 5：缺少端到端性能 SLA gate

证据：
- 现有 `multi-pane-refresh.test.ts` 只覆盖 refresh targets / dedupe。
- debug metrics 记录 bps/renderHz/pullHz，但没有 `capture -> render` latency gate。

红测：
- 新增 synthetic multi-pane latency test：2/3 pane 同时输出，必须能计算每 pane p95 latency。
- 新增 slow-link simulation test：backpressure 增长时 render latency 允许变慢，但 queue 不持续增长。
- 新增 good-link simulation test：good transport 下 active / visible pane p95 不得被固定 slow path 卡住。
- 新增 no-client-state-in-daemon source gate：daemon scheduler 不得 import / read client UI state 字段。

预期实现：
- 增加有界性能 trace ring buffer，默认只记录 metadata/timestamps/bytes，不记录真实 terminal payload 内容。
- daemon `/debug/runtime` 或现有 debug store 暴露 trace summary。
- 测试以 synthetic clock / fake transport 为主，真机作为补充证据。

## 5. 文件清单

预计触达：
- `android/src/server/terminal-mirror-runtime.ts`
- `android/src/server/terminal-mirror-capture.ts`
- `android/src/server/terminal-transport-runtime.ts`
- `android/src/server/terminal-runtime-types.ts`
- `android/src/server/terminal-debug-runtime.ts`
- `android/src/server/runtime-debug-store.ts`
- `android/src/contexts/session-context-buffer-runtime.ts`
- `android/src/contexts/session-context-transport-runtime.ts`
- `android/src/lib/mobile-config.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/session-debug-metrics-store.ts`

预计新增/扩展测试：
- `android/src/server/terminal-mirror-runtime.test.ts`
- `android/src/server/terminal-transport-runtime.test.ts`
- `android/src/server/terminal-performance-scheduler.test.ts`
- `android/src/contexts/session-context-weak-network-fix.test.ts`
- `android/src/contexts/multi-pane-refresh.test.ts`
- `android/src/lib/session-render-gate.test.ts`
- `android/src/lib/session-debug-metrics-store.test.ts`
- source gate tests for daemon/client boundary.

需同步文档/skill：
- `android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`
- `.agents/skills/terminal-buffer-truth/SKILL.md`
- `android/docs/dev-workflow.md`（如新增固定验证门禁）
- `android/note.md`
- `android/MEMORY.md`
- `android/CACHE.md`

## 6. 风险与规避

- 风险：为了快而裁剪真实 payload。
  - 规避：红测锁定 payload 语义等价，只允许裁剪 debug/trace。
- 风险：daemon scheduler 偷看 client active/follow/viewport。
  - 规避：source gate + 类型边界测试。
- 风险：backpressure 处理变成 fallback 或吞错。
  - 规避：send error / non-open / queue overflow 必须显式事件化。
- 风险：多 pane fast lane 造成 request storm。
  - 规避：语义去重、per-mirror in-flight、global fair queue 红测。
- 风险：只在单测通过，真机仍慢。
  - 规避：增加 trace summary，并在真机/daemon runtime evidence 中对齐关键 timestamp。

## 7. 实施步骤

1. 更新 terminal 真源文档与 local skill，冻结性能调度边界：
   - daemon 可消费 transport physical backpressure / mirror capture metrics；
   - daemon 不可消费 client UI state；
   - client 可消费自己的 transport quality / render cost。
2. 为五类问题分别补红测，并确认每个问题至少一个核心用例在当前实现下失败；红测失败输出必须记录到最终报告或 evidence 摘要。
3. 实现性能 trace metadata：
   - capture start/end；
   - canonicalize done；
   - send start/end；
   - client rx；
   - buffer apply；
   - render commit。
4. 实现 daemon scheduler：
   - good / normal / poor / overloaded lane；
   - capture over-budget backoff；
   - per-mirror in-flight guard；
   - global fair scheduling。
5. 实现 transport backpressure truth：
   - ws / rtc unified snapshot；
   - send bytes / buffered bytes / send error；
   - scheduler 消费。
6. 实现 client cadence / render fast lane：
   - good link 16ms render；
   - weak/backpressure slow lane；
   - 保持 semantic debounce，避免 request storm。
7. 跑完整定向验证：
   - server scheduler / transport tests；
   - client cadence / render / multi-pane tests；
   - source gates；
   - type-check。
8. 跑 terminal regression：
   - contracts；
   - common flows；
   - daemon mirror；
   - relay smoke；
   - 真机安装态 trace 验证若无法自动化，必须说明缺口与替代证据。
9. 更新 `android/note.md`、提炼已验证结论到 `android/MEMORY.md`、压缩 `android/CACHE.md`。
10. 构建 Android 升级 APK，并复制到升级路径：
   - `android/update-dist/<apk>`
   - `~/.wterm/updates/<apk>`
   - 输出 sha256。
11. Git 检查只包含本轮相关文件后提交；worktree 有无关 dirty 文件时必须精确 stage 本轮相关文件。
12. 推送到当前分支。

## 8. 验证矩阵

必须通过：
- `pnpm --dir android exec tsc --noEmit`
- server terminal scheduler / transport 定向测试
- client weak-network / multi-pane / render gate 定向测试
- source boundary gates
- `pnpm --dir android test:terminal:regression`
- Android APK build / sync 所需命令，产物必须可从升级路径读取

必须提供证据：
- 红测失败证据：每类问题至少一条 failing test 输出或明确说明为何当前实现已被前置测试覆盖。
- 修复后转绿证据。
- trace summary 示例：至少包含 2 pane 或 3 pane case 的 timestamp summary。
- APK 路径与 sha256：必须包含 `android/update-dist/` 与 `~/.wterm/updates/` 两个位置。
- git commit hash。
- push 成功输出。

## 9. 完成定义

任务完成必须同时满足：
- 五类问题均有红测。
- 所有红测修复后转绿。
- 自动验证全绿。
- Android 升级 APK 已构建并复制到升级路径，sha256 已记录。
- 文档/skill/memory/cache 更新完成。
- 本轮变更已 commit。
- commit 已 push 到远端当前分支。
- 最终报告包含：改了什么、红测覆盖、验证命令、APK 路径与 sha256、commit hash、push 结果、剩余风险。

## 10. 2026-06-08 执行任务冻结

本节是给 `/goal` 执行用的落盘任务单，优先级高于前文的条件描述。

执行顺序：
1. 先确认五类审计问题的红测清单完整；缺少红测的先补测试，并保留 fail-first 证据。
2. 再实现缺口，不允许通过裁剪真实 terminal payload、吞 send error、fallback 或 daemon 读取 client UI state 达成提速。
3. 跑定向测试、source boundary gate、type-check、`test:terminal:regression`。
4. 构建新的 Android APK，并交付到 `android/update-dist/` 和 `~/.wterm/updates/`，记录 sha256。
5. 更新 `android/note.md`、`android/MEMORY.md`、`android/CACHE.md`。
6. 精确 stage 本任务相关文件，提交并推送当前分支。

红测最低覆盖：
- 问题 1 daemon live push 自适应：好网 fast lane、弱网/backpressure slow lane、scheduler 禁止 client UI state。
- 问题 2 capture cost / fairness：capture duration 进入调度，over-budget 不重入，不饿死其他 mirror。
- 问题 3 transport backpressure：ws/rtc buffered bytes 统一进入 snapshot，send fail 显式暴露，backpressure 不无限堆积。
- 问题 4 client cadence/render：好网 16ms fast lane，弱网 slow lane，输入后的 tail refresh 不被普通 debounce 吃掉。
- 问题 5 端到端 SLA：多 pane synthetic trace 能计算 p95，good link 不被固定慢路径卡住，trace 不记录真实 payload 内容。

提交前禁止项：
- 禁止 staging 无关 dirty 文件、release 资产删除、mac 无关改动。
- 禁止 broad kill。
- 禁止宣称完成但没有红测失败证据、转绿证据、APK 路径、commit hash、push 输出。

## 11. 2026-07-13 完整实现基线

本节基于 2026-07-13 的源码审计和真实 daemon `/health`、`/debug/runtime`、`/debug/runtime/logs` 证据追加。与前文冲突时以本节为准。任务目标是闭环性能，不是把前文每个候选优化机械实现；是否进入 renderer 或 wire v2 必须由生产 trace 和明确阈值决定。

### 11.1 已确认基线

- daemon 默认 `DEFAULT_DAEMON_TERMINAL_CACHE_LINES=3000`。
- live mirror 样本存在 `bufferedLines=3000`，最近 flush duration 样本约 `150-354ms`。
- 最近 500 条 client runtime logs 中：
  - 69 条 `buffer-sync`；
  - 64 条是 1 行 diff；
  - 3 条 `lineCount>=1000`；
  - 最大 3000 行；
  - 165 条 inactive `buffer-sync.preparse-inactive-drop`；
  - 61 条 `runtime.debug.drop-summary`，累计 dropped 793。
- `terminal-mirror-runtime.ts` 的 subscriber backpressure 当前直接跳过该次 diff，没有 subscriber-local pending latest truth。
- 高频 pre-serialized `sendText()` 没有完整更新 send bytes/error/trace。
- client cadence 支持 `runtimeTransport.rttMs`，但生产输入没有真实 session RTT。
- renderer 已保持 next-RAF commit，不能添加网络相关 render debounce；剩余 projection 优化必须先由 trace 证明。
- 当前 live daemon 启动时间早于 worktree 的部分变更，因此它是现场性能样本，不是当前源码版本的最终闭环证据。

### 11.2 最终目标与验收

目标：

1. 好网下 active/visible terminal 更新不被固定 timer、全窗口 capture 或全窗口 renderer projection无意义限速。
2. 弱网、窄带宽、抖动和短时停顿下不堆积历史帧、不丢最终权威状态、不让 inactive session 消耗正文带宽。
3. tmux 继续拥有 terminal 排版；daemon mirror 是唯一正文/geometry 真源；client 不重排、不猜 anchor、不建立第二份正文。
4. 所有优化保持真实请求/响应语义等价；只允许裁剪 debug/trace metadata，不允许裁剪 terminal 业务 payload 达成提速。

必须达到：

- metadata-only `capture -> canonicalize -> send -> rx -> apply -> RAF -> commit` trace 在真实 daemon 和 Android client 主链可用。
- inactive、非 visible、无 bootstrap demand 的 session transport 保持物理连接，但正文订阅不产生 `buffer-sync` 字节；同样样本下 inactive body bytes 至少下降 95%。
- 每个 subscriber 背压期间最多保留一个 bounded pending latest truth；输出停止并 transport drain 后，客户端必须在 `max(1000ms, 2 * measured RTT)` 内达到 daemon latest revision。
- 一个 slow subscriber 不得降低其他 healthy subscriber 的发送 cadence。
- 同一真实 TUI/输入样本下，daemon hot-path capture + canonicalize p95 相对基线至少下降 60%，且 tmux oracle、mirror absolute indexes、cursor、rows/cols 完全一致。
- good-link 真实样本中 `client-rx -> render-commit` p95 不超过 32ms；body 到达后不得被网络 cadence 二次延迟。
- 256 Kbps、300ms RTT、50-150ms jitter、周期性 1-2s stall 的真实字节限速代理路径中：
  - send queue 不无界增长；
  - inactive session 不接收正文；
  - active session 无 stale final frame；
  - reconnect/resume 后 visible tail 可恢复；
  - input string payload 语义不变。
- 所有红测、架构 gate、L2 daemon/tmux、L3 client transport、L4 app shell、L5 真机弱网 smoke 通过。

### 11.3 资源与唯一 owner

涉及功能：

- `terminal.buffer_render`
- `terminal.transport_lifecycle`
- `terminal.daemon_input`
- `daemon.runtime_entry`
- `daemon.cli_node`

涉及资源：

- `resource.tmux_session`
- `resource.mirror_store`
- `resource.transport_subscriber`
- `resource.session_transport`
- `resource.client_sparse_buffer`
- `resource.renderer_window`
- `resource.debug_channel`

唯一 owner：

- tmux capture/readback 与 mirror commit：`src/server/terminal-mirror-capture.ts`
- mirror cadence、subscriber broadcast、pending latest：`src/server/terminal-mirror-runtime.ts`
- send accounting/backpressure snapshot：`src/server/terminal-transport-runtime.ts`
- wire builder/parser：`src/server/buffer-sync-contract.ts` 与 client 相邻 parser owner
- client cadence/RTT input：`src/lib/session-runtime-cadence.ts`、`src/lib/mobile-config.ts`
- client body apply：`src/contexts/session-context-buffer-runtime.ts`
- renderer commit：`src/lib/session-render-gate.ts`
- renderer snapshot store：`src/lib/session-render-buffer-store.ts`
- debug/trace：debug owner 模块，不进入 terminal payload

禁止：

- renderer/client 本地 wrap、reflow、内容拼接或 anchor 推断。
- daemon 读取 active tab、foreground、reading、follow、viewport 或 pane UI state。
- head/range request 触发 tmux capture。
- 为兼容旧行为保留隐藏双路径、fallback、第二协议成功路径。
- 通过降低真实 terminal history、丢最后一帧、吞 send error 或清空本地 buffer 提速。

资源关系、function map、mainline call map、test design 与 gate 必须先同步。若新 wire/version 或 subscription relation 尚未声明，先标 `binding pending`，不得伪造 symbol。

### 11.4 技术方案

#### A. 生产性能 trace 与 debug 收口

新增同一 `trace_id / mirror_revision / subscriber_id` 可关联的 metadata stage：

```text
capture-start
capture-done
canonicalize-done
mirror-commit
send-start
send-done
client-rx
buffer-apply-done
render-raf
render-commit
```

每条只允许：

- timestamp / duration
- bytes / line count / range count
- revision / absolute bounds
- transport kind / buffered bytes
- id / error code

禁止 terminal text、cells、command、token、文件内容进入 trace。

`/debug/runtime` 输出 per-session/per-mirror p50/p95/p99、render Hz、payload Bps、capture cost、queue high-water、coalesced count、inactive body bytes。ring buffer 必须有界。

现有 `session.buffer.apply.inspect`、`session.render-gate.flush.inspect` 等重 payload debug：

- 默认生产关闭；
- 开启时也只构造 metadata summary；
- 禁止发送 terminal 行文本；
- debug drop 不得影响业务链。

#### B. 物理正文订阅 demand

保持 client session transport 打开，不在 tab/pane 切换时 fresh recreate。

新增或收口唯一 physical body subscription truth：

```text
visible/bootstrap demand
  -> session transport subscription intent
  -> daemon transport subscriber bodySubscribed
  -> mirror broadcast eligibility
```

daemon 只保存 `bodySubscribed`、transport health、last delivered revision 等物理订阅事实，不保存 active/inactive/visible/foreground 原因。

要求：

- active pane和所有 visible panes订阅正文；
- inactive/non-visible 且无 bootstrap demand 的 transport 取消正文订阅；
- unsubscribe 不关闭 transport，不销毁 mirror；
- resubscribe 先恢复物理订阅，再走当前 mirror head + visible/tail demand；
- `buffer-head-request` / `buffer-sync-request` 仍只读 mirror，不触发 capture；
- 只有 ready 且 `bodySubscribed` 的 physical subscriber count 驱动 daemon capture cadence，不成为客户端 UI 真相；
- subscription 改变必须回到唯一 mirror scheduler owner：最后一个 demand 消失时立即停旧 timer，demand 恢复时立即恢复 live sync。

若需要新增 wire control message，必须先定义 version、builder/parser、正反 contract tests、protocol mismatch 显式错误和旧链物理删除计划。禁止静默兼容双路径。

#### C. Backpressure latest-authoritative coalescing

每 subscriber 维护有界物理发送状态：

```text
lastDeliveredRevision
bufferedBytes
highWaterEnteredAt
pendingLatestRevision
pendingChangedAbsoluteRanges
pendingSince
```

规则：

- healthy subscriber 立即发送；
- 达到 high-water 后不排每个历史 payload；
- 将之后所有 changed absolute ranges 合并到一个 pending latest truth；
- pending rows 始终在 flush 时从最新 mirror store 读取；
- transport 下降到 low-water 后发送一次 latest authoritative projection；
- 成功 send 后推进 `lastDeliveredRevision` 并清 pending；
- send error 显式记录，不能当成功清 pending；
- 高低水位必须迟滞；
- pending memory/范围数有硬上限，超过上限进入显式 protocol resync 状态，不能静默 drop。

如果现有连续 span contract 无法在 revision gap 下同时满足语义正确和窄带宽目标，则进入明确的 Buffer Sync V2：

```text
baseRevision
revision
availableStartIndex
availableEndIndex
ranges[] {
  startIndex
  endIndex
  compactLines[]
}
cursor metadata
```

V2 只发送从 `baseRevision` 到 `revision` 之间所有 changed rows 的最新权威值。客户端只有在 base revision contract 满足时 apply；不满足时显式报 revision mismatch 并走唯一 visible repair owner。V2 必须有协议协商/版本门禁，不能偷偷保留双业务路径。

进入 V2 的硬判定：

- 同一真实样本连续 span payload 的 `sentLineCount / changedLineCount` p95 大于 4；或
- 单次 span payload p95 大于 64 KiB；或
- coalesced revision gap 必须发送超过 client retained window 才能保证正确。

满足任一条件必须实现 V2；否则记录证据并不做无收益协议迁移。

#### D. Daemon hot-tail authoritative range capture

保持一个 mirror writer、一个 mirror store。禁止 `history capture + visible capture + concat` 双真源。

允许的优化是：每个 cycle 只有一次 tmux authoritative capture，capture window 可以是 hot absolute range；range anchor 必须只来自 tmux readback：

```text
history_size
pane_rows
pane_cols
alternate_on
capture returned line count
```

不得用文本 overlap、重复内容或客户端状态推断 anchor。

稳定旧 history 只能作为同一 mirror store 内先前已确认的 absolute rows保留。发生以下任一结构事实时必须 full authoritative reconciliation：

- history size 回退或清空；
- rows/cols 变化；
- alternate screen 变化；
- adaptive tmux resize readback；
- absolute window 不连续；
- capture range 超出当前 mirror continuity；
- periodic bounded reconciliation 到期；
- owner validator 判定 range patch 不可证明。

full reconciliation 仍是 single capture -> canonicalize -> authoritative mirror commit。hot range patch 和 full reconciliation 都只能经过同一 owning validator/committer。

必须先更新 terminal truth decision、local skill、resource/function/call maps 和测试设计，再允许实现这一架构变化。

#### E. Send accounting 与真实 RTT

`sendTransportMessage()` 和 pre-serialized `sendText()` 必须经过同一 send accounting owner：

- bytes
- total bytes
- last success/error
- buffered amount before/after
- send timestamp/duration
- backpressure transitions

不能为统计重新 stringify 高频 payload。

client 从现有 ping/pong 或 head request/reply correlation 计算：

- RTT EWMA
- jitter EWMA
- recent timeout/stall count
- last progress age
- downlink payload cadence

这些事实进入现有 cadence resolver。网络 cadence只控制 head/pull/probe/reading sync，不控制正文到达后的 RAF commit。

#### F. Renderer profiling 与条件优化

先用生产 trace 判定：

- 若 `client-rx -> buffer-apply-done` 或 `buffer-apply-done -> render-commit` p95 超过 16ms；
- 或 renderer main-thread stage 占 capture-to-render p95 超过 25%；

则实现 absolute dirty-row projection：

- buffer apply 输出 changed absolute indexes；
- render gate 只投影 changed rows；
- 未变化 row 保持对象引用；
- geometry/window shift 走显式 full projection；
- renderer 仍不排版、不重排。

未达到阈值，不做 renderer 重构，并在 evidence 中记录“测量证明非当前瓶颈”。

#### G. 真实弱网测试代理

新增 app/daemon 主链外的测试 harness，提供真实字节转发：

- bandwidth cap
- fixed latency
- jitter
- periodic stall
- explicit disconnect

代理只用于测试，不解析或改写 terminal payload，不进入生产 runtime truth。

至少覆盖：

- good：低延迟、无限速；
- narrow：256 Kbps、300ms RTT、50-150ms jitter；
- unstable：narrow 基础上每 10-20s stall 1-2s；
- reconnect：显式断开后恢复。

Android 真机必须经该代理连接当前 staged daemon，不能只跑 fake clock/unit test。

### 11.5 测试设计

实施前更新 `docs/testing/terminal-refresh-buffer-truth-test-design.md`，至少包含：

- 生命周期：capture、commit、broadcast、backpressure、drain、client apply、render。
- white-box：scheduler、range merge、low-water flush、RTT EWMA、dirty-row projector。
- module black-box：daemon mirror + two subscribers；client socket + sparse buffer + renderer。
- project black-box：真实 tmux `top` / `vim` / 高速输出、Android 真机、弱网代理。
- 已知缺口与非目标。

正向测试：

- healthy immediate send。
- slow subscriber pending latest drain 后达到 latest revision。
- inactive正文订阅停止字节，transport 仍 open。
- visible multi-pane 都继续刷新。
- hot range patch 与 full reconciliation 的 mirror 等于 tmux oracle。
- good link body 下一 RAF commit。
- RTT 变差后 producer cadence 降低。
- V2 若触发，稀疏 ranges 正确 apply。

反向测试：

- slow subscriber 不拖慢 healthy subscriber。
- pending queue 不按 revision 无界增长。
- output 停止后不能留下 stale final frame。
- unsubscribe 不关闭 transport、不销毁 mirror、不改 open tabs。
- daemon 不出现 active/follow/reading/viewport/UI 字段。
- head/range request 不触发 tmux capture。
- hot range 不使用内容 overlap 推 anchor。
- geometry/history discontinuity 不能错误 patch，必须进入 full reconciliation。
- send error 不能清 pending或推进 delivered revision。
- runtime debug/trace 不包含 terminal text/cells。
- renderer 不因弱网增加 debounce。
- input payload 保持 string-only。
- protocol mismatch 显式失败，不走旧链 fallback。

### 11.6 实施顺序

1. 刷新 `.agent-collab`，按 `feature_id/resource_id/mainline_node_id/gate_id` 建 claim；不同 worker 不得共同写同一 owner 文件。
2. MemoryPalace -> resource registry/map -> function map -> mainline call map -> verification map -> canonical source。
3. 更新 architecture decision、resource registry/map、function map、mainline call map、wiki、test design、local skill；新 symbol 未实现标 `binding pending`。
4. 先补 trace/debug metadata 红测并确认失败，再实现生产 trace。
5. 建立弱网代理和基线采集，保存同一 tmux/Android样本的 before evidence。
6. 先补 physical body subscription 正反红测，再实现 inactive bandwidth 收口。
7. 先补 backpressure pending latest 正反红测，再实现 high/low-water 和 drain flush。
8. 根据 span inflation hard threshold 决定是否进入 Buffer Sync V2；若进入，先文档/manifest/contract 红测，再做协调迁移和旧链物理删除。
9. 先补 hot-tail/full-reconciliation oracle 红测，再实现唯一 mirror writer 内的 authoritative range capture。
10. 补全 `sendText()` accounting 和 client RTT/jitter/stall。
11. 用 trace 判断是否触发 renderer dirty-row 优化阈值；触发才实施。
12. 运行 L0-L5 完整门禁；失败回唯一 owner 修，不做 fallback。
13. 将确证经验从 `note.md` 提炼到 `MEMORY.md` 和 local skill；运行安全语料 mine，并搜索新短语证明可检索。
14. 精确 stage 本任务文件，独立 review diff 和 evidence；验证后 commit 并 push 当前分支。禁止夹带其它 worker 变更。

### 11.7 必跑验证

L0/L1：

- resource/function/mainline/architecture gates
- server scheduler/transport/mirror/contract tests
- client cadence/buffer/render/multi-pane tests
- runtime debug/trace payload red tests
- typecheck

L2：

- `pnpm --dir android run daemon:mirror:close-loop`
- 真实 tmux oracle：`top`、`vim`、高速单行更新、history growth、clear-history、resize、alternate screen
- two-subscriber healthy/slow isolation

L3/L4：

- Android open-tab/transport/buffer/TerminalView/TerminalPage targeted gates
- Mac client transport/runtime gates，证明共享 daemon contract 没破坏
- `pnpm --dir mac test -- --reporter dot`
- `pnpm --dir mac run type-check`

L5：

- staging current daemon artifact并 managed restart，禁止 broad kill
- health/debug trace schema验证
- 构建 Android升级 APK
- 在线真机安装、解锁、zterm foreground
- 真机经弱网代理完成 good/narrow/unstable/reconnect 四组 smoke
- exact same tmux sample before/after replay

完整回归：

- `pnpm --dir android run test:terminal:regression`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --dir android run test:feature-registry -- --reporter dot`
- `pnpm --dir android run build:android`
- `git diff --check`

### 11.8 Evidence 要求

必须保存：

- before/after trace summary
- capture/canonicalize p50/p95/p99
- payload bytes、line count、range inflation
- inactive body bytes
- queue/pending high-water
- RTT/jitter/stall
- client rx/apply/render p50/p95/p99
- healthy + slow subscriber隔离结果
- tmux oracle vs mirror/client final revision
- APK versionName/versionCode/path/sha256
- daemon artifact/version/pid/health
- 真机前台、未锁屏、真实 session 和弱网 profile 证明
- fail-first 红测摘要和转绿摘要
- commit hash 与 push 结果

不能用构建成功、单测成功、静态阅读或旧 daemon日志代替真实当前版本闭环。

### 11.9 完成定义

只有同时满足以下条件才可宣称完成：

- 资源关系、function map、mainline call map、wiki、test design、skill 与代码一致且有 gate。
- production trace 可量化完整 capture-to-render 主链，且不泄漏 terminal payload。
- inactive正文带宽、backpressure final-state、hot capture cost、真实 RTT cadence 达到 11.2 的验收阈值。
- renderer 是否修改有 trace 判定证据；未触发阈值则明确记录不改原因。
- wire V2 是否实施有 hard threshold 证据；若实施，旧业务链已按计划物理删除，无 fallback。
- L0-L5、完整回归和 exact sample replay 全通过。
- Android APK和当前 daemon artifact均已真实运行验证。
- 文档、note、MEMORY、skill、MemoryPalace 检索闭环完成。
- 本任务变更已由独立 checker review，精确提交并 push。
- 没有遗留 pending latest、无界 queue、stale final frame、inactive正文浪费或 client terminal reflow。
