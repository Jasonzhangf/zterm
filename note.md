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
