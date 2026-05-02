## 2026-04-21 Mac shell workspace implementation
- Goal: replace static preview with real shell workspace (single pane by default, vertical split on demand, pane tabs, no persistent sidebars, blue-gray)
- Truth: keep runtime honest; first slice only active pane/tab drives live bridge session
- Success: type-check + package pass + packaged app visual smoke

## 2026-04-25 Android client refresh initialization audit
- Symptom: active tab may stay `connecting`, blank, low/0Hz refresh until input/focus side effects.
- Hypothesis 1: initialization still depended too hard on `connected`; if first live frame arrives before/without clean `connected`, client can self-block.
- Hypothesis 2: active head tick and active-tab initialization still gate on `session.state === connected`, so a tab stuck in `connecting` never keeps polling head and never self-heals.
- Decision: keep daemon pull-only; fix client initialization only at three points: 1) accept live `buffer-head`/`buffer-sync` as connected establishment signal; 2) active head tick must continue while `connecting|reconnecting`; 3) active tab switch/initialization must request head immediately instead of scheduling unrelated reading repair.
- Success evidence: targeted vitest covers `buffer-head` establishment + `connecting` state keeps polling head; type-check passes.

## 2026-04-25 transport truth trim
- Removed wrong transport-active model: client no longer treats recently viewed tabs as 33ms active; only the current active session keeps high-frequency head polling.
- Removed dead transport side-path: client/server now only use `buffer-head` + explicit range request for terminal sync.
- Tightened input refresh: only reading->follow transition forces head refresh; burst input no longer bypasses the head throttle.

## 2026-04-25 terminal role freeze
- Server only mirrors tmux truth and answers `head` + requested `ranges`.
- Server must not carry strategy/render semantics: no follow/reading state, no patch planning, no render-driven behavior.
- Multi-session means multiple parallel canonical buffers; server does not infer client intent across sessions.
- Client buffer worker only polls head and requests explicit buffer ranges.
- Renderer only owns follow/reading + `renderBottomIndex`, and only consumes buffer.

## 2026-04-27 Android input render / cursor audit
- 已先钉死：**terminal 可见输入内容不是 Android client 本地直接画出来的**。`TerminalView` 隐藏输入只负责 `onInput` 后清空自身 value，不会 append render rows；`SessionContext.sendInput()` 只发 ws `input` + `buffer-head-request(force)`，不改本地 buffer。证据：`android/src/components/TerminalView.tsx:905-914, 971-1012`；`android/src/contexts/SessionContext.tsx:2704-2713`；`android/src/contexts/SessionContext.ws-refresh.test.tsx:1420-1433, 3382-3389`。
- 当前“输入区样式和 tmux 不同 / 光标问题不变”的主嫌疑已转到 **daemon cursor projection**。`android/src/server/server.ts:1021-1026` 会调用 `paintCursorIntoViewport()`；而 `android/src/server/canonical-buffer.ts:68-70` 当前会给目标 cell 注入 `FLAG_REVERSE | FLAG_CURSOR`，这属于对 tmux mirror 的第二语义投影。
- 新门禁顺序固定为：1) 先证明输入文字只在 `buffer-sync` 后出现；2) 再比 prompt/input 行的 `char/fg/bg/flags` 是否已在 daemon payload 中漂移；3) payload 若已错，先修 daemon，不能先怪 renderer / IME。
- 新增回环门禁：
  - Android IME 输入后、`buffer-sync` 前，terminal 可见内容不得本地提前变化
  - `buffer-sync` 后，renderer 只能回显 payload
  - daemon cursor paint 不得为普通 prompt/input cell 注入 synthetic reverse style
- 已按单点真源修正 daemon cursor projection：`android/src/server/canonical-buffer.ts` 现仅保留 `FLAG_CURSOR`，不再注入 `FLAG_REVERSE`。证据：`pnpm --dir android exec vitest run src/server/canonical-buffer.test.ts` 13/13 通过；`pnpm --dir android exec vitest run src/App.android-ime-input-loop.test.tsx` 2/2 通过；`pnpm --dir android exec vitest run src/components/TerminalView.dynamic-refresh.test.tsx src/components/TerminalView.theme.test.tsx` 44/44 通过；`pnpm --dir android run daemon:mirror:close-loop` 全 case 通过，summary 在 `android/evidence/daemon-mirror/2026-04-27/summary.json`。
- 进一步收紧真源后，上一条还不够：**daemon 连 `FLAG_CURSOR` 也不该打进 buffer**。当前 active code 仍违规：`android/src/server/server.ts:1021-1026` 仍调用 `paintCursorIntoViewport()`，`android/src/server/canonical-buffer.ts:56-86` 仍会改写 viewport rows。正确实现应为：daemon 保持 raw tmux buffer 不变；cursor 若要下发，必须走独立 metadata，而不是改 `lines[].cells[].flags`。
- 已完成该重构：daemon 不再对 viewport / buffer rows 做 cursor paint，`paintCursorIntoViewport()` 整块已删除；`TerminalBufferPayload.cursor` / `SessionBufferState.cursor` 成为独立真相；renderer 改为消费 `cursor metadata` 做显示，不再从 `cell.flags` 读取伪 cursor。为保证 cursor 移动/`cursorKeysApp` 变化仍会刷新，daemon revision 现在在 **buffer changed 或 cursor/meta changed** 时推进。
- 本轮证据：
  - `pnpm --dir android exec vitest run src/server/buffer-sync-contract.test.ts src/lib/terminal-buffer.test.ts src/components/TerminalView.theme.test.tsx src/components/TerminalView.dynamic-refresh.test.tsx src/server/canonical-buffer.test.ts` → 79/79
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/App.android-ime-input-loop.test.tsx src/App.first-paint.real-terminal.test.tsx` → 67/67
  - `pnpm --dir android run daemon:mirror:close-loop` → all replay + strict audit cases passed，summary 仍在 `android/evidence/daemon-mirror/2026-04-27/summary.json`

## 2026-04-27 Android 正文解析 / IME overlay 分层审计
- 现场截图里的底部灰条不能直接判成 daemon 正文解析错误；它属于 **IME/editor overlay 层**，必须和 terminal body 回显分层审。
- 已做本地 probe：`WasmBridge row -> compactLine() -> expandCompactLine()`，覆盖正文 `ANSI + CJK + reverse + bg span + 中间空格`；当前 **可见正文语义** 可以 roundtrip，因此“正文整体解析坏了”目前**证据不足**。
- 但 compact decode 仍有一处真实 drift：`android/src/server/buffer-sync-contract.ts` 在恢复双宽 continuation cell 时写回 `char: 0`，而 daemon 原始 row 常见真值是 `char: 32, width: 0`。这属于 contract 语义漂移，需先用红灯测试钉住，再判断它是否真是现场正文问题的主根因。
- 后续门禁固定为三组分层测试：
  1. **server contract body parity**：正文 mixed row 的 compact roundtrip；
  2. **renderer parity**：body row 只消费 payload，不被 cursor metadata / overlay 污染；
  3. **IME/editor isolation**：editor overlay 不得冒充 terminal body。

## 2026-04-27 Android QuickBar / IME shell 门禁补充
- QuickBar 属于 **UI shell**，只能处理键盘抬升、点击保护、快捷入口；它**不得**通过穿透点击去触发 terminal/ImeAnchor，也不得影响 buffer / renderer 真相。
- 新真源门禁：
  1. **QuickBar 整个 shell 区域**（不仅按钮命中框）都必须拦截非交互点击，空白处点击不得弹出 IME；
  2. 只有显式 editor/input/button 控件允许接管焦点，普通 shell 点击必须留在 UI shell 层；
  3. 键盘可见且有 `keyboardInsetPx` 时，shell rows 必须整体抬升到键盘上方，不能被 IME 覆盖。

## 2026-04-27 daemon restart recover 回环门禁补充
- `daemon-restart-recover` 若 direct daemon payload 已与 tmux 一致，但 close-loop 仍报 `client local mirror diverged`，优先排查 **回放 harness 是否遗漏 revision reset 语义**，不要误报成 daemon/client 主链坏了。
- 自动回放 client mirror 时，若后续 `buffer-sync.revision < localRevision`，必须按真实 client 语义先 reset 本地 buffer truth，再 apply 新 payload；否则会把 daemon 重启后的合法低 revision 误判成假红。

## 2026-04-27 transport / session lifecycle 真源冻结
- 新冻结：**client session 是稳定业务对象，ws/rtc transport 是可替换物理连接**。inactive tab 只停取数，不关闭 session / transport；reconnect 必须是 same-session retry，不是 brand-new session recreate。
- daemon 侧补充真源：ws close 只允许 detach transport，不允许顺手删 logical client session；logical client session 只允许由显式 `close` 或 daemon shutdown 回收。
- 本轮实现顺序固定为：1) 先落 truth docs / skill / checklist；2) 再补红测；3) 再改 daemon/client；4) 最后再跑 close-loop + APK。

## 2026-04-27 Android IME 顶部 inset 重复计算
- 现场“弹出输入法后顶部空白突然变大”已收敛到 **UI shell 顶部 inset 第二语义**：`TerminalPage.resolveTerminalHeaderTopInsetPx()` 把 Android `visualViewport.offsetTop` 当成 header top inset，而 IME 弹起时该值会跳变，导致 header 顶部被再次抬高。
- 冻结修法：Android header 顶部 inset 只能取 UI shell 的稳定基线，不得把 IME / viewport 偏移再叠到 header 上；键盘抬升只允许影响底部可见区域与 QuickBar，不得改 header 顶部真相。

## 2026-04-27 Android UI shell / tmux geometry 越层
- 这轮更严重的现场不是 header inset，而是 **Android client 在 connect/reconnect 时仍把 UI 容器推导出来的 viewport rows/cols 带给 daemon**，导致键盘/前后台/容器高度变化会改 tmux 窗高。
- 真源重新钉死：Android UI shell 只能改容器位置与可见高度；**看不到的区域不渲染是 renderer 窗口职责**，不是 tmux/daemon/buffer manager 的职责。正确修法必须先删除 `UI shell -> tmux viewport` 这条错误链。

## 2026-04-27 follow 假性 reading 回归根因补充
- `TerminalView` 新加的 pending-follow 漂移保护一开始写宽了：只要 `pendingFollowRenderBottomIndex` 非空，就会把任何 scroll 都当成“等待 follow realign”，把真正的用户上滚也吃掉。
- 但仅靠收紧成“看 `pendingFollowScrollSyncRef`”也不够，因为后续无 guard 的 follow sync 会把前一个 guarded pending 状态冲掉，导致 live refresh 的 DOM 漂移又重新误判成 reading。
- 本轮收口：1) 只有 `guardPendingFollowDrift` 为真时，follow 漂移保护才拦截 scroll；2) `queueFollowScrollSync` 不能把已存在的 guarded pending 状态降级回普通 pending。这样既保住“用户真上滚 -> reading”，也保住“live tail refresh 漂移 -> 不进 reading”。

## 2026-04-27 client mirror replay 门禁补强
- 我继续追“最新内容在历史里反复出现 / 循环 buffer”时，先拿本地自动回环验证：现有 `applyBufferSyncToSessionBuffer` 低层测试、`SessionContext` 紧贴现场的 compact-follow / back-to-back sync 测试，以及 `client-mirror-replay` 对 `2026-04-27` 全套 evidence case 回放，目前都**未复现**该问题。
- 因此这类问题下一步不能靠瞎改，要优先抓**现场 head/request/buffer-sync 序列**再喂回 replay harness；在此之前，先把 replay evidence 正式纳入 `test:terminal:contracts`，保证现有 close-loop case 不倒退。

## 2026-04-27 runtime debug 时序分析门禁
- 为了继续收敛“field 看起来像循环 buffer，但本地 close-loop 复现不到”的问题，新增了 `runtime-debug-sequence` 分析器：它专门检查 **某次 `buffer-sync` 已经到达之后，后续 `buffer-head` / `buffer-request` 里本地 `revision/endIndex` 仍然没推进** 的异常。
- 对历史现场证据 `android/evidence/runtime-audit/2026-04-26/logs-after-apk.json` 跑分析，确实能抓到一串异常（例如 `buffer-sync revision=45/end=57788` 后，下一条 `session.buffer.head` 仍报 `localRevision=22/localEnd=57783`）。这说明旧现场至少确实存在过 **incoming buffer-sync 已到，但 client local truth 没及时前进** 的时序问题。
- 为了下一轮能直接判定“到底是没进 apply，还是 apply 了但后面又读到旧 truth”，`SessionContext.applyIncomingBufferSync()` 现在新增了两条 runtime debug：
  - `session.buffer.applied`
  - `session.buffer.apply.noop`
  这样后续现场只要打开 runtime debug，就能直接看到每个 `buffer-sync` 是否真的把 local truth 推进了。
- 同时新增了一键抓取脚本 `pnpm --dir android exec tsx scripts/collect-runtime-audit.ts --host <host> --token <token> [--sessionId ... | --tmuxSessionName ...]`，它会自动拉：
  - `/debug/runtime`
  - `/debug/runtime/logs`
  - `sequence-analysis.json`
  输出到 `android/evidence/runtime-audit/<date>/<timestamp>-<label>/`，后续 Jason 只需要复现，我就可以自己抓，不再让 Jason 手工搬日志。

## 2026-04-27 file transfer remote cwd truth
- 远端文件传输默认目录不属于 client env truth。`process.env.HOME` 是错误第二语义。
- 正确真相：sheet 打开时若未指定目录，daemon 按当前 tmux session 的 `#{pane_current_path}` 解析并返回真实目录。


## 2026-04-27 Terminal transient flower + QuickBar 3-row freeze
- 1306 现场“花一下后自愈、输入后更快恢复”当前先冻结为 renderer follow frame transient mismatch；先补红测钉死，不允许先拍脑袋改 daemon/buffer。
- QuickBar 结构冻结：第一行工具栏（文件/图片/同步/截图/状态/键盘），第二行单键，第三行复合键；浮动菜单只留快速输入/剪贴板/自定义快捷内容。

## 2026-05-01 daemon terminal core second slice
- Goal: continue de-clienting daemon by moving mirror live-sync / tmux attach / session input orchestration out of server transport glue into terminal-runtime.
- Truth: server.ts should keep transport/http glue only; terminal runtime owns logical session + mirror lifecycle + tmux mirror orchestration, but still shares the same sessions/mirrors maps from server.ts.
- Success: targeted lifecycle tests + terminal contracts + type-check stay green, and server.ts no longer hosts attach/live-sync/input implementations.

## 2026-05-01 daemon terminal core fourth slice
- Goal: continue shrinking `server.ts` by moving file list / mkdir / download / upload / remote screenshot / attach-file binary / paste-image binary into a dedicated file-transfer runtime.
- Truth: daemon file runtime only owns `remote cwd -> fs/screenshot-helper/tmux input -> transfer protocol`; it must not grow client preview/state semantics.
- Guard: `server.ts` may keep request/session-required checks and protocol dispatch only; no fallback from binary payload to raw terminal input.

## 2026-05-01 daemon terminal core debug slice
- Symptom: `server.ts` still carried debug/log helper ownership (`local-time timestamp / daemon runtime debug / client-debug normalize / payload summary`), conflicting with the target of transport+shutdown glue only.
- Decision: move the whole debug/log helper cluster into `terminal-debug-runtime.ts`; keep `server.ts` only destructuring runtime exports and wiring them into http/message/transport runtimes.
- Verification:
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit`
  - `pnpm --dir android exec vitest run src/server/server.debug-truth.test.ts src/server/server.transport-runtime-truth.test.ts src/server/server.control-truth.test.ts src/server/server.schedule-truth.test.ts src/server/server.http-truth.test.ts src/server/server.file-transfer-truth.test.ts src/server/server.mirror-capture-truth.test.ts src/server/server.transport-lifecycle-truth.test.ts src/server/client-session-lifecycle.test.ts src/server/mirror-lifecycle.test.ts --reporter verbose`
  - `pnpm --dir android run test:terminal:contracts`

## 2026-05-01 daemon terminal core support + daemon service slice
- Symptom: even after runtime/control/debug/file/message extraction, `server.ts` still held two non-glue clusters:
  1. terminal core normalize/sanitize/helper truth
  2. daemon service helper truth (`resolveTmuxBinary / auth token parse / heartbeat / memory guard / shutdown / listen logs`)
- Decision:
  - move terminal helper truth to `terminal-core-support.ts`
  - move daemon service helper truth to `terminal-daemon-runtime.ts`
  - keep `server.ts` as wiring shell for `http / ws / rtc / message / transport / shutdown entry`
- Verification:
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit`
  - `pnpm --dir android exec vitest run src/server/server.daemon-runtime-truth.test.ts src/server/server.core-support-truth.test.ts src/server/server.debug-truth.test.ts src/server/server.transport-runtime-truth.test.ts src/server/server.control-truth.test.ts src/server/server.schedule-truth.test.ts src/server/server.http-truth.test.ts src/server/server.file-transfer-truth.test.ts src/server/server.mirror-capture-truth.test.ts src/server/server.transport-lifecycle-truth.test.ts src/server/client-session-lifecycle.test.ts src/server/mirror-lifecycle.test.ts --reporter verbose`
  - `pnpm --dir android run test:terminal:contracts`

## 2026-05-01 daemon bridge slice
- Symptom: after helper/runtime extraction, `server.ts` still directly hosted the last large bridge glue cluster:
  - ws `connection/pong/message/close/error`
  - rtc transport `open/close/error`
  - `/signal` vs `/ws` upgrade routing
  - relay-host signal bridge to rtc bridge
- Decision:
  - move this cluster into `terminal-bridge-runtime.ts`
  - keep `server.ts` as composition shell that wires `bridge + daemon + message + transport + http`
- Verification:
  - `pnpm --dir android exec vitest run src/server/server.bridge-runtime-truth.test.ts src/server/server.daemon-runtime-truth.test.ts src/server/server.core-support-truth.test.ts src/server/server.debug-truth.test.ts src/server/server.transport-runtime-truth.test.ts src/server/server.control-truth.test.ts src/server/server.schedule-truth.test.ts src/server/server.http-truth.test.ts src/server/server.file-transfer-truth.test.ts src/server/server.mirror-capture-truth.test.ts src/server/server.transport-lifecycle-truth.test.ts src/server/client-session-lifecycle.test.ts src/server/mirror-lifecycle.test.ts --reporter verbose`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit`
  - `pnpm --dir android run test:terminal:contracts`


## 2026-05-01 protocol truth + daemon restore
- 先验证后结论：这次“改了 shared 协议但 TS 还像没生效”不是 TypeScript 缓存玄学，而是 workspace 软链真错了。
- 实际根因：`android/node_modules/@zterm/shared -> ../../../../../../../private/tmp/zterm-safe-7850bd3/packages/shared`
- 止血动作：`pnpm install --force --config.confirmModulesPurge=false`
- 修复后软链：`android/node_modules/@zterm/shared -> ../../../packages/shared`
- 协议收口：
  - `packages/shared/src/connection/types.ts` 补齐 `cursor / WireIndexedLine / SessionBufferState.cursor`
  - `packages/shared/src/connection/protocol.ts` 补齐当前 wire 消息：`debug-log / debug-control / tmux-* / paste-image-start / terminal-width-mode / file-create-directory-* / file upload progress+complete 扩展字段`
  - `android/src/lib/types.ts` 删除本地协议 union/interface 真相，改成 `BridgeClientMessage/BridgeServerMessage` alias + shared re-export
- 新 source gate：`android/src/lib/protocol-truth.test.ts`
- daemon 恢复证据：
  - `/health` = ok, pid=41420
  - `android/evidence/daemon-mirror/2026-05-01/initial-sync/probe-events.json` 已看到：
    - sent `session-open`
    - recv `session-ticket`
    - sent `connect`
    - recv `connected`
    - recv `buffer-head`
    - recv `buffer-sync` with `wireKind=compact`
- 额外发现：`server.ts` 装配顺序里 `relayHostClient` 不能早于 bridge runtime；否则会形成 `handleRelaySignal/closeRelayPeer` 未定义使用。这次已收成唯一顺序：daemon runtime -> bridge runtime -> relay host client。

## 2026-05-02 protocol freeze + client split
- Goal: 冻结 terminal protocol/document truth，然后对客户端巨型文件做低风险拆分，不改 wire 语义。
- Constraints: 不改 daemon/client 协议语义；不引入 fallback；先文档后代码；只做 ownership 下沉，不做行为改写。
- Candidate giant files: SessionContext.tsx (3893 LOC), TerminalQuickBar.tsx (3196 LOC), App.tsx (1265 LOC).
- Decision: 本轮优先拆 SessionContext 的协议/刷新 helper，原因：它直接承载 head/range/input/transport 协议收发，最需要先从巨型 orchestrator 中分离成可测试模块；QuickBar 后续再拆。
- Success: docs 明确写出 protocol freeze；SessionContext 下沉 helper 后 type-check + 关键回归通过。

## 2026-05-02 daemon-related split + refresh restore
- Goal: 先把客户端里与 daemon/transport refresh 直接相关的编排逻辑继续拆出来，并保证 active session refresh 主链不退化。
- Scope: 优先处理 SessionContext / App 中的 daemon transport + foreground resume + head-first refresh orchestration。
- Guard: 不改协议语义；不加 fallback；先补/保回归，再改代码。
- Success: daemon-related ownership 下沉后，type-check + ws-refresh/App.dynamic-refresh 回归继续绿。

## 2026-05-02 terminal truth re-freeze before implementation
- User hard constraint: **先闭环整个逻辑 -> 更新认知 -> 对齐 AGENTS / skills / docs -> 然后再开始落代码**
- Re-frozen model:
  1. daemon 只管 `tmux -> mirror truth`
  2. transport 是长期复用长链接，不因 foreground/background/tab switch fresh recreate
  3. renderer 是 visible range 唯一真相，拥有 `follow / reading / renderBottomIndex`
  4. buffer manager 只管 local sparse buffer / gap repair / merge / line-range patch，不持有 renderer state
  5. gap 必须先空白占位，再按行/区间局部重刷
- Current evidence from code audit:
  - `SessionContext.tsx` / `session-sync-helpers.ts` 仍混有 `renderDemand / follow / reading` 语义
  - transport 仍偏 `cleanup old socket -> fresh reconnect`
  - 这与最新冻结模型冲突
- Next step frozen:
  - 先完成文档对齐
  - 再做 client code retain/delete/downshift audit
  - 再补红测后开始代码收口

## 2026-05-02 client audit retain/delete/downshift result
- Retain:
  - `App.tsx -> performForegroundRefresh(...)` 作为 foreground resume 唯一入口
  - `SessionContext.tsx -> requestSessionBufferHead / applyIncomingBufferSync / active tick / sendInput`
  - `session-sync-helpers.ts` 中 normalize / pull bookkeeping / availability / impossible-window 这类纯 helper
- Delete or downshift:
  - `sessionRenderDemandRef`
  - `buildFollowRenderDemandState`
  - `shouldPullFollowBuffer`
  - `shouldPullReadingBuffer`
  - `shouldCatchUpFollowTailAfterBufferApply`
  - `updateSessionViewport` 当前 renderer state / worker demand 混合接口
  - `session-sync-helpers.ts` 里基于 `renderDemand.mode / viewportEndIndex / viewportRows` 的 planner 语义
- Transport truth violations found:
  - `cleanupSocket -> new ws -> connect`
  - `connectSession / reconnectSession / openSocketConnectHandshake`
  - `ensureActiveSessionFresh / probeOrReconnectStaleSessionTransport`
  - 这些仍然带 fresh reconnect/fresh connect 心智，不符合长期复用 transport 真相
- Frozen implementation order:
  1. 先把 renderer -> worker 接口收成 visible range declaration
  2. 再删除 worker 内 follow/reading/renderBottomIndex 语义
  3. 再收 transport 长链接复用真相
  4. 最后收 tab/session 去重与持久化

## 2026-05-02 client visible-range 收口（第二刀）
- 目标：让 SessionContext / session-sync-helpers 不再持有 renderer `follow/reading/renderBottomIndex` 语义，只吃 visible range。
- 现状：worker 仍通过 `sessionRenderDemandRef + TerminalViewportState.mode` 决定 tail-refresh / reading-repair，违背最新真源。
- 决策：
  1. `updateSessionViewport` 只接收 `TerminalVisibleRange`
  2. `sessionRenderDemandRef` 改为 `sessionVisibleRangeRef`
  3. tail-refresh 仅基于 daemon head + local buffer + visibleRange(仅提供 viewportRows/endIndex fallback)
  4. reading repair 改为 `visible-range gap repair`：只要 visible range 内有 gap/缺口就拉 repair，不再依赖 renderer mode
- 风险控制：保持 wire 协议不动；先补 helper 单测，再跑 ws-refresh / render-scope 回归。

## 2026-05-02 transport third cut plan
- 目标：transport open/reconnect 只保留一个握手实现，减少 `connectSession` 与 `startReconnectAttempt` 的重复 finalize/onConnected 分叉。
- 现状：两处都在拼 `pendingSessionTransportOpenIntentsRef`、handshake settle、failure/connected 回调，属于重复的 transport lifecycle 编排。
- 决策：抽出单一 `queueSessionTransportOpenIntent(...)`，connect/reconnect 只提供 mode-specific hooks；不改 wire 语义。

## 2026-05-02 transport third cut stop-bleed
- 现象：`SessionContext.tsx` type-check 失败；`SessionContext.ws-refresh.test.tsx` 运行时报 `ReferenceError: Cannot access 'scheduleReconnect' before initialization`。
- 验证：根因不是第二刀 visible-range，而是第三刀让 `startReconnectAttempt` 与 `scheduleReconnect` 在 `useCallback const` 初始化期互相直接引用。
- 止血动作：只把 callback 内互调改为 `startReconnectAttemptRef.current?.(...)` / `scheduleReconnectRef.current?.(...)`，不回退第二刀，不改协议。
- 证据：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/lib/app-foreground-refresh.test.ts --reporter dot`
  - `5 files / 115 tests passed`
- 约束：第三刀后续不能再直接抽 hook 层统一入口；先抽纯 helper / runtime orchestrator，最后再接回 `SessionContext`。

## 2026-05-02 transport third cut helper closeout round-2
- 本轮只下沉纯 helper：
  - managed session 复用排序/判定
  - transport open intent 的 handshake settle / live-failure 去重状态机
- `SessionContext` 现在只保留：
  - connect/reconnect 的业务分叉
  - helper 产物回接到 control transport open
- 验证：
  - `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts --reporter dot` => `17 passed`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/lib/app-foreground-refresh.test.ts --reporter dot` => `104 passed`
- 下一步：继续抽 connect/reconnect 的共用 hook-free 配置构造，直到 `SessionContext` 只剩 transport orchestrator 壳。

## 2026-05-02 transport third cut helper closeout round-3
- 本轮把 `connectSession / reconnectSession / createSession(existing)` 里重复拼的 session metadata / connecting-reconnecting updates / schedule loading state 下沉成纯 helper。
- 现在 `SessionContext` 在这些点上不再自己散拼 `hostId/connectionName/bridgeHost/...`。
- 验证：
  - `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts --reporter dot` => `21 passed`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/lib/app-foreground-refresh.test.ts --reporter dot` => `104 passed`
- 下一步：继续抽 connect/reconnect 的失败分流与 success 回调配置，逐步让 `SessionContext` 只剩 orchestrator 壳。

## 2026-05-02 transport third cut helper closeout round-4
- 本轮把失败分流里的状态更新真源继续下沉：
  - reconnect attempt progress
  - connecting label/sessionName
  - schedule error state
  - error / idle-after-block / reconnecting-failure updates
- 当前 `SessionContext` 在失败分支里已经明显只剩“调用哪个 helper + 调度下一步”的壳。
- 验证：
  - `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts --reporter dot` => `27 passed`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/lib/app-foreground-refresh.test.ts --reporter dot` => `104 passed`
- 下一步：继续抽 connected success / reconnect callbacks 的共用配置，最后再看是否能把 connect/reconnect 统一成单一 orchestrator。

## 2026-05-02 transport third cut helper closeout round-5
- 本轮把 `handleSocketConnectedBaseline(...)` 里散写的 connected baseline 真源继续下沉：
  - local window 预判
  - connected updates
  - schedule-list loading reset
  - connected 后是否需要 pending tail refresh / request head
- 验证：
  - `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts --reporter dot` => `31 passed`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/lib/app-foreground-refresh.test.ts --reporter dot` => `104 passed`
- 下一步：开始收 `connect/reconnect` 的 callback 配置壳，尽量把 `SessionContext` 缩到真正的 orchestrator。

## 2026-05-02 transport third cut helper closeout round-6
- 本轮开始把 `connect/reconnect` callback 壳里的“做什么”抽成纯计划：
  - reconnect handshake failure: terminal-error vs retry(nextAttempt)
  - connected effect: debug event / clear superseded / flush pending input
  - live failure effect: clear pending intent / token / schedule error / reconnect
- 当前 `SessionContext` 在这些 callback 里进一步变成“按 plan 执行 side effect”的壳。
- 验证：
  - `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts --reporter dot` => `34 passed`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/lib/app-foreground-refresh.test.ts --reporter dot` => `104 passed`
- 下一步：继续把 open-intent 参数装配收成 builder，逼近单一 orchestrator 入口。

## 2026-05-02 transport third cut helper closeout round-7
- 本轮开始把 callback 壳本地执行器成形：
  - `applyTransportOpenConnectedEffects`
  - `applyTransportOpenLiveFailureEffects`
  - `handleReconnectBeforeConnectSend`
  - `handleReconnectHandshakeFailure`
  - `queueReconnectTransportOpenIntent`
  - `queueConnectTransportOpenIntent`
- 中途再次出现 TDZ：`startReconnectAttempt` 直接依赖后声明的 `queueReconnectTransportOpenIntent`。
- 止血方式保持一致：改为 `queueReconnectTransportOpenIntentRef.current?.(...) / queueConnectTransportOpenIntentRef.current?.(...)`，不引入新拓扑耦合。
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/lib/app-foreground-refresh.test.ts --reporter dot` => `104 passed`
- 下一步：继续把 open-intent 参数 builder 收出来，再看 connect/reconnect 是否只剩一层 orchestrator。

## 2026-05-02 transport third cut helper closeout round-8
- 本轮把 `queueReconnectTransportOpenIntent / queueConnectTransportOpenIntent` 的 open-intent 参数装配抽成 builder。
- 为避免 builder 再把 hook 依赖拓扑绕乱，新增 effect/handler refs 做桥接。
- 当前 `queue*TransportOpenIntent` 已明显缩成“取 builder 结果 -> 派发”。
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/lib/app-foreground-refresh.test.ts --reporter dot` => `104 passed`
- 下一步：判断是否继续把 `connectSession/startReconnectAttempt` 收成单入口，还是在当前层面冻结为“已可维护的唯一壳”。

## 2026-05-02 transport third cut helper closeout round-9
- 本轮只做最小 A 尝试：新增 `buildSessionTransportPrimeState(...)`，统一 `connectSession / reconnectSession` 的 pre-open prime 真源：
  - `resolvedSessionName`
  - `transportHost`
  - `sessionUpdates`
- 验证后判断：继续把 `connectSession/startReconnectAttempt` 强合成单一 hook 入口，不再是“低风险收口”，而是会放大：
  - `useCallback const` 初始化环
  - ref 桥接数量
  - TDZ / ReferenceError 风险
- 因此第三刀当前阶段冻结为：
  1. helper 真源
  2. callback 执行器壳
  3. open-intent builder
  4. pre-open prime helper
- 后续若继续收，正确方向不是继续堆 ref，而是先把 transport lifecycle 抽成 hook 外独立 runtime orchestrator。
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/lib/app-foreground-refresh.test.ts --reporter dot` => `5 files / 139 tests passed`

## 2026-05-02 tab/session owner audit closeout round-1
- 审计发现：
  - `SessionContext` 已经是 session/state/active 的真相 owner
  - 但 `App.tsx` 仍自带一份：
    - open-tabs restore/persist helper
    - live session reuse 判定
  - 这会让 tab/session 绑定关系继续存在第二语义风险
- 本轮收口动作：
  - 新增 `android/src/lib/open-tab-persistence.ts`
  - 把 `read/persist/dedupe/buildPersistedOpenTab` 全部收进去
  - 新增 `findReusableOpenTabSession(...)`，直接复用 `findReusableManagedSession(...)`
  - 删除 `App.tsx` 本地的 `findReusableSession(...)`
- 结果：
  - `App.tsx` 继续只做 orchestration
  - open tab restore/persist/reuse 有了单独 source module
  - restore 与 quick-open 的复用语义不再分叉
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/lib/open-tab-persistence.test.ts src/App.dynamic-refresh.test.tsx src/App.first-paint.test.tsx src/App.first-paint.real-terminal.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot` => `5 files / 119 tests passed`

## 2026-05-02 tab/session owner audit closeout round-2
- 继续追后发现，round-1 还没彻底关死：
  - switch/move/close 的持久化大多仍靠 rerender + effect 补写
  - `handleSendSessionDraft(...)` 直接调 `switchSession(...)`，会绕过 intent 持久化入口
- 本轮直接收成 intent-time truth：
  - `persistSessionIntentState(...)`
  - `handleSwitchSession(...)` 当下写 `ACTIVE_SESSION`
  - `handleMoveSession(...)` 当下写重排后的 `OPEN_TABS`
  - `handleCloseSession(...)` 当下写关闭后的 `OPEN_TABS + ACTIVE_SESSION`
  - `handleSendSessionDraft(...)` 改成走 `handleSwitchSession(...)`
- 结果：
  - active/programmatic/move/close 四条 tab intent 现在都不再依赖后续 rerender 才持久化
  - tab intent 持久化入口收成了单一口径
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/lib/open-tab-persistence.test.ts src/App.dynamic-refresh.test.tsx src/App.first-paint.test.tsx --reporter dot` => `3 files / 27 tests passed`

## 2026-05-02 active tab persistence owner audit freeze
- 这轮不再往下写代码，先判断 owner 边界是否该继续下沉。
- 审计后结论：`ACTIVE_SESSION` 不该直接沉进 `SessionContext`。
- 原因：
  1. `ACTIVE_SESSION` 和 `ACTIVE_PAGE` 是同一条 app restore 语义链
  2. `App.tsx` 才拥有 page routing / page restore / tab restore orchestration
  3. `SessionContext` 只该拥有 session runtime/transport/buffer 真相，不该知道 page 是否在 terminal
- 冻结后的职责：
  - `SessionContext`：active session runtime truth
  - `open-tab-persistence.ts`：tab persistence truth
  - `App.tsx`：把 runtime active 提升为 app restore truth
- 因此这块到此冻结，不再继续强行下沉，避免 page-state 与 session-state 再次混层。

## 2026-05-02 tab/session source gate closeout round-3
- 本轮补了 `saved tab list restore` 的 source gate。
- 过程中定位到两个真实口子：
  1. `openDraftAsSession(...)` 不透传 `sessionId`，saved-tab load 后 rename/active targeting 会漂
  2. `handleLoadSavedTabList(...)` 若复用 `handleSwitchSession(...)`，会因为旧 `sessions` 闭包把 `ACTIVE_SESSION` 覆盖回旧值
- 修法：
  - `openDraftAsSession(..., { sessionId })`
  - batch load 完成后走：
    1. `persistOpenTabsState(openedTabs, focusSessionId)`
    2. `switchSession(focusSessionId)`
    3. `setPageState(openTerminalPage(focusSessionId))`
- 结论：saved-tab load 是**批量恢复路径**，不能简单套普通 single-tab intent handler。
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/App.dynamic-refresh.test.tsx src/App.first-paint.test.tsx src/lib/open-tab-persistence.test.ts --reporter dot` => `3 files / 28 tests passed`

## 2026-05-02 tab/session reopen truth audit
- 现象：关闭过的 tab 仍会在下次启动时被默认重开；部分 session/tab 即使用户关闭仍会重新出现。
- 假设：`OPEN_TABS` 被 runtime `sessions[]` 自动回写污染，导致“运行中仍存在的 session”被重新持久化成“下次必须重开”。
- 验证：`android/src/App.tsx` restore effect 中，`restoredTabsHandledRef.current` 之后会无条件执行 `persistOpenTabsState(sessions.map(buildPersistedOpenTabFromSession(...)), activeSessionId)`；这违反了 open-tab 与 runtime-session 解耦。
- 决策：本轮改为 App 级显式 `openTabs` 真源；只在明确 tab intent（open/switch/move/close/saved-tab restore）时改写并持久化；禁止 `sessions[] -> OPEN_TABS` 自动回填。
## 2026-05-02 foreground/ansi audit
- 现象1：A=1 但恢复后刷新率极低，像仍处于后台/hidden cadence。已定位 SessionContext active tick 直接读 document.visibilityState，与 App.tsx 的 Capacitor appState/resume 双真源并存。
- 现象2：红绿背景变灰。TerminalView 本地 ANSI 0-15/256 映射看起来正确；WasmBridge 实测分号 truecolor / ANSI 41/42 能正确得到 bg=196/46/1/2。
- 新发现：WasmBridge 对冒号格式 truecolor SGR（48:2::r:g:b / 38:2::...）完全不生效，返回 DEFAULT_COLOR=256；若 tmux capture 输出该格式，客户端会落回 theme 默认/透明，肉眼像灰。需查 tmux capture 实际输出格式。
- 结论倾向：前后台问题先收口客户端唯一前后台真源；颜色问题高概率是 parser 不支持 colon-style SGR 或 capture 链输出格式问题，而非 TerminalView palette。
