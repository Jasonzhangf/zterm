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
