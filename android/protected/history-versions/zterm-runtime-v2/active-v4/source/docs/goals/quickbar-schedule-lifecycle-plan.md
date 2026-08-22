# QuickBar Floating Menu + Schedule Lifecycle Plan

## Goal

修复 Android 终端快捷悬浮球与定时发送链路：

1. 悬浮球快捷输入面板压缩竖向排版，删除无效说明和不可达 UI。
2. 定时发送 sheet 打开后锁定目标 session，避免切 tab 后任务漂移。
3. 补齐 schedule 操作的发送失败、daemon 错误、loading/error 展示与生命周期退出路径。
4. 修复 `tmux_session_unavailable` 被误当成 closed tab 的 transport 语义。
5. 完成测试门禁、构建 APK，并交付到升级路径。

## Acceptance Criteria

- QuickBar floating menu:
  - 首屏面板更紧凑，header 只保留必要标题和关闭入口。
  - quick composer 默认高度明显降低，`定时` / `发送` 在同一 action row 内。
  - 不存在空 tab/pill 行。
  - `clipboard` 分支必须二选一：补真实入口，或物理删除不可达代码。
  - inline shell rows 在 floating menu 打开时隐藏，关闭后恢复的现有生命周期不回退。

- Schedule target lifecycle:
  - 从 session A 打开 schedule sheet 后，即使用户切到 session B，保存/刷新/删除/启停/run now 仍作用于 A。
  - sheet 打开期间目标 session 缺失或 transport 不可用时必须显式报错，不得漂移到当前 active session。
  - draft seed 只影响本次打开的 composer，关闭后清理，不污染下一次打开。

- Schedule error lifecycle:
  - socket 非 OPEN 时，schedule 操作不得静默丢消息；必须 `loading=false` 并写入 `scheduleState.error`。
  - daemon 的 schedule 业务错误必须进入 schedule 专属错误通道，不得只走 terminal transport failure。
  - delete/toggle/run-now 遇到 stale job 必须有明确 state/event/error 结束信号。
  - UI 必须展示 schedule loading/error，用户能知道当前操作是否失败。

- Daemon schedule truth:
  - 定时任务仍由 daemon 持久化、计算 `nextFireAt`、执行 tmux 写入。
  - Android 只做当前 session 的编辑器和控制入口，不新增本地调度器。
  - client 离线时 daemon 已保存任务仍可继续执行。

- Transport lifecycle:
  - `tmux_session_unavailable` 是 retryable temporary error，不得直接触发 closed-tab lifecycle。
  - `tmux_session_killed` 仍是明确 closed event。

- Delivery:
  - 通过定向测试、typecheck、terminal regression、common flows、daemon mirror smoke。
  - 构建新版 APK。
  - APK 复制到 `android/update-dist/` 和 `~/.wterm/updates/` 升级路径。

## Scope

### In Scope

- `android/src/components/terminal/TerminalQuickBar.tsx`
- `android/src/components/terminal/terminal-quickbar-helpers.tsx`
- `android/src/components/terminal/TerminalQuickBar.test.tsx`
- `android/src/components/terminal/SessionScheduleSheet.tsx`
- `android/src/components/terminal/SessionScheduleSheet.test.tsx`
- `android/src/pages/TerminalPage.tsx`
- `android/src/pages/TerminalPageQuickBarAssembly.tsx`
- `android/src/pages/terminal-page-quickbar-adapters.ts`
- `android/src/pages/useTerminalPageOverlays.ts` if the existing overlay hook owns schedule state
- `android/src/pages/useTerminalPageOverlays.test.tsx`
- `android/src/contexts/session-context-public-runtime.ts`
- `android/src/contexts/session-context-public-facade-runtime.ts`
- `android/src/contexts/session-context-socket-message-runtime.ts`
- `android/src/contexts/session-context-socket-message-runtime.test.ts`
- `android/src/server/terminal-message-control-runtime.ts`
- `android/src/server/terminal-schedule-runtime.ts`
- `android/src/server/schedule-engine.ts`
- `android/src/server/schedule-dispatch.ts`
- Relevant schedule server tests.
- Build/update scripts only if required for versioned APK delivery.

### Out of Scope

- 不改 schedule 产品语义，例如新增复杂 cron、跨 session schedule group。
- 不新增 Android 本地定时器。
- 不改 daemon mirror/buffer/render 主链路，除非 `tmux_session_unavailable` 语义修复必须触达 transport lifecycle。
- 不重做整个 QuickBar 设计系统，只做本问题需要的紧凑化和死语义清理。
- 不引入 fallback / dual path compensation。

## Design Principles

- Daemon is the only schedule execution truth.
- UI sheet must bind to a frozen target session for its whole open lifecycle.
- Schedule errors are business errors and must enter schedule state, not terminal transport failure unless the transport itself failed.
- No silent return after a user action that changes schedule state.
- Remove unreachable or duplicate UI/code physically after confirming it has no owner.
- Keep terminal server / buffer manager / renderer / UI shell boundaries unchanged.

## Technical Plan

### 1. Freeze Schedule Sheet Target

Owner: `TerminalPage.tsx`

- Replace the current `scheduleOpen + scheduleComposerSeed` only model with a target object:

```ts
interface ScheduleComposerTarget {
  sessionId: string;
  sessionName: string;
  seedText: string;
  nonce: number;
}
```

- On `handleQuickBarOpenScheduleComposer(text)`:
  - resolve current `uiSessionId`;
  - find the matching session;
  - freeze `{ sessionId, sessionName, seedText: text, nonce: Date.now() }`;
  - request schedule list for the frozen `sessionId`;
  - open sheet.

- In `SessionScheduleSheet` props:
  - use frozen `sessionName`;
  - use schedule state keyed by frozen `sessionId`;
  - all operations use frozen `sessionId`.

- On close:
  - close sheet;
  - clear frozen target.

- If frozen target session disappears while sheet is open:
  - keep sheet bound to the original target label;
  - disable mutating controls or surface a clear error;
  - do not rebind to active session.

### 2. Make Schedule Client Sends Explicit

Owner: `session-context-public-runtime.ts`

- Change schedule send path from silent fire-and-forget to explicit result.
- `sendMessageRuntime` can remain generic if needed, but schedule operations must know whether a message was actually sent.
- Required behavior:
  - if session not found: set `loading=false`, `error='session not found'`;
  - if socket missing/not OPEN: set `loading=false`, `error='schedule transport not connected'`;
  - if sent: set `loading=true`, clear error, wait for schedule-state/event/error.

- Avoid fallback reconnect inside schedule action. Transport freshness belongs to existing transport owner; schedule UI only reports unavailable state.

### 3. Add Schedule-Specific Error Handling

Owner:
- server: `terminal-message-control-runtime.ts`, `terminal-schedule-runtime.ts`, `schedule-engine.ts`
- client: `session-context-socket-message-runtime.ts`

- Add or reuse a dedicated server message type, preferably:

```ts
{
  type: 'schedule-error',
  payload: {
    sessionName: string;
    operation: 'list' | 'upsert' | 'delete' | 'toggle' | 'run-now';
    jobId?: string;
    code: string;
    message: string;
  }
}
```

- Client behavior:
  - update only the matching `SessionScheduleState`;
  - set `loading=false`, `error=message`;
  - preserve existing jobs unless a `schedule-state` says otherwise.

- Server behavior:
  - upsert validation failure emits `schedule-error`;
  - delete/toggle/run-now stale job emits `schedule-error`;
  - run-now execution failure still updates job `lastResult='error'` through engine state/event.

### 4. Render Schedule Loading/Error in Sheet

Owner: `SessionScheduleSheet.tsx`

- Display loading state near header or action row.
- Display `scheduleState.error` in a compact error strip.
- Disable or mark pending for create/update/delete/toggle/run-now while loading if repeated mutation would create ambiguity.
- Keep job-level `lastResult/lastError` display for daemon execution failures.

### 5. Compact Floating Quick Menu

Owner: `TerminalQuickBar.tsx`

- Header:
  - remove explanatory text;
  - reduce padding/gap;
  - keep close icon.

- Composer:
  - reduce textarea min height from current 148px to compact default;
  - keep multiline support via internal scroll/resize as appropriate;
  - move `定时` and `发送` into one action row.

- Tabs / clipboard:
  - remove the empty single-pill row.
  - If clipboard is still in scope, add a real segmented control with `快捷` and `剪贴板`.
  - If clipboard is not accepted as an active feature, physically remove clipboard-only unreachable branch and unused state/imports.

- Quick action list:
  - reduce item min height and vertical gap;
  - keep label + preview readable;
  - preserve double-tap send semantics and trailing-enter normalization.

### 6. Fix `tmux_session_unavailable` Transport Semantics

Owner: `session-context-socket-message-runtime.ts`

- Keep `tmux_session_killed` as closed tab event.
- Treat `tmux_session_unavailable` as retryable failure:
  - call `onFailure(message, true)`;
  - do not null socket handlers as a closed event;
  - do not call `onClosed`.
- Preserve existing red tests and add/keep explicit test coverage for both codes.

### 7. Delivery APK

- After tests pass, build a new Android debug/release upgrade package using existing project workflow.
- Copy/sync APK to:
  - `android/update-dist/`
  - `~/.wterm/updates/`
- Record version, sha256, and path in final evidence.

## Risks And Mitigations

- Risk: schedule target freeze conflicts with current active session state.
  - Mitigation: frozen target is sheet-local; active terminal remains independent.

- Risk: adding schedule-error touches shared message union.
  - Mitigation: update type definitions and socket handler tests together; avoid generic `error` overloading.

- Risk: compact QuickBar accidentally breaks existing copy/keyboard/split actions.
  - Mitigation: run `TerminalQuickBar.test.tsx` and keep shell row open/close tests green.

- Risk: deleting clipboard branch removes a hidden used feature.
  - Mitigation: first confirm no reachable trigger; if keeping it, add real segmented control and tests.

- Risk: APK build picks stale web/native artifacts.
  - Mitigation: run the existing Android build workflow from `android/docs/dev-workflow.md` and verify output sha256.

## Test Matrix

### Component/UI

- `TerminalQuickBar.test.tsx`
  - floating menu compact header has no helper text.
  - action row contains both `定时` and `发送`.
  - no empty tab/pill button.
  - shell rows hide while floating menu is open and restore on close.
  - schedule composer still receives current draft.
  - quick action double tap still sends normalized payload.

- `SessionScheduleSheet.test.tsx`
  - renders loading state.
  - renders `scheduleState.error`.
  - disables or guards mutating actions while loading.
  - seed text reset/close behavior remains correct.

### Page Lifecycle

- `TerminalPage` or overlay hook tests:
  - opening schedule from session A freezes target A.
  - switching to session B while sheet is open does not alter target.
  - close clears target and next open uses new active session.
  - missing frozen session reports explicit error and does not drift.

### Client Context

- `session-context-public-runtime` tests:
  - schedule list/upsert/delete/toggle/run-now with closed socket sets error and clears loading.
  - sent message sets loading and clears previous error.

- `session-context-socket-message-runtime.test.ts`
  - `schedule-state` clears loading.
  - `schedule-event` clears loading and records event.
  - `schedule-error` clears loading and records error.
  - `tmux_session_unavailable` is retryable and does not close.
  - `tmux_session_killed` still closes.

### Server

- `terminal-message-runtime.test.ts` / `terminal-message-control-runtime` tests:
  - schedule upsert validation failure emits schedule-error.
  - delete/toggle/run-now stale job emits schedule-error.

- `schedule-engine.test.ts`
  - existing timer/persist/execute tests remain green.
  - run-now execution failure updates job state/event.

- `schedule-dispatch.test.ts`
  - tmux write semantics remain correct.
  - test wording avoids fallback semantics.

- `server.schedule-truth.test.ts`
  - daemon schedule orchestration remains in dedicated runtime.

### Build And Smoke

- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- Terminal regression suite from `android/docs/dev-workflow.md`
- Common flows suite
- Daemon mirror smoke
- Android native build / APK packaging
- APK sha256 verification and copy to upgrade paths

## Execution Steps

1. Read latest `android/CACHE.md`, `android/MEMORY.md`, `android/docs/spec.md`, `android/docs/architecture.md`, `android/docs/dev-workflow.md`, and relevant owner files.
2. Implement schedule target freeze in `TerminalPage` and tests.
3. Implement explicit client schedule send result/error lifecycle and tests.
4. Implement schedule-specific server/client error channel and tests.
5. Render schedule loading/error in `SessionScheduleSheet` and tests.
6. Compact QuickBar floating menu, remove or repair unreachable clipboard/tab UI, and tests.
7. Fix `tmux_session_unavailable` retryable transport semantics and tests.
8. Run directed tests.
9. Run typecheck and broader regression gates.
10. Build APK and copy to upgrade paths.
11. Update `android/note.md` during exploration and summarize verified results into `android/MEMORY.md` / `android/CACHE.md` at completion.
12. Final report with changed files, tests, APK paths, sha256, and remaining risk.

## Definition Of Done

- All acceptance criteria are satisfied.
- No schedule operation can silently remain loading after an unsent message or daemon business error.
- Schedule sheet target cannot drift after tab switch.
- QuickBar floating menu is visibly compact and has no unreachable blank tab control.
- `tmux_session_unavailable` lifecycle test is green.
- Required tests and build gates pass.
- New APK is delivered to both upgrade paths.
- Final answer includes evidence: test results, build path, sha256, and any residual risk.
