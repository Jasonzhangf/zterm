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

### 问题 4：client cadence / render commit 固定 33ms，好网没有 fast lane

证据：
- `mobile-config.ts` 好网默认 `headTickMs=33`、`renderCommitMs=33`。
- `session-render-gate.ts` 使用 `Math.max(16, renderCommitMs)`，默认仍 33ms。
- `session-context-buffer-runtime.ts` sync debounce 固定 33ms。

红测：
- 好网红测：低 RTT / 空队列 / 小 payload 下 render commit cadence 可进入 16ms fast lane。
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
