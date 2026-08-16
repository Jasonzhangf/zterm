# Terminal Follow Scroll State Machine Test Design

Date: 2026-07-27
Feature: `terminal.buffer_render`
Owner: `client.renderer_window` / TerminalView follow scroll runtime
Goal task: architecture-gap closeout T8

## 1. Architecture mapping

- Resource path: `resource.client_sparse_buffer -> resource.renderer_window -> resource.ui_projection`
- Unique owner: TerminalView follow/reading scroll state machine
- Allowed paths:
  - `android/src/lib/terminal-follow-scroll-runtime.ts`
  - `android/src/lib/terminal-follow-scroll-runtime.test.ts`
  - `android/src/components/TerminalView.tsx`
  - existing shared helpers under `packages/shared/src/terminal/renderer*` that already own programmatic scroll math
- Forbidden paths:
  - daemon mirror / transport reconnect
  - SessionContext buffer planner compensating scroll mode
  - TerminalPage chrome / QuickBar / IME lift as follow/reading owner
- Edit class: separate scattered TerminalView refs into one pure state machine; no wire protocol change

## 2. Current truth and gap

Current product already has shared pure helpers:

- `queueTerminalFollowScrollSync`
- `cancelTerminalFollowScrollSync`
- `flushTerminalFollowScrollSync`
- `handleTerminalFollowModeScrollGuards`
- `commitProgrammaticTerminalScroll`
- `markUserScrollIntent` / `hasRecentUserScrollIntent`

Gap:

- TerminalView still owns ~10 loosely coupled refs:
  - `pendingFollowScrollSyncRef`
  - `pendingFollowRenderBottomIndexRef`
  - `pendingImmediateFollowScrollSyncRef`
  - `pendingFollowViewportRealignRef`
  - `followScrollSyncTimerRef`
  - `recentViewportLayoutChangeRef` / timer
  - `suppressProgrammaticScrollRef`
  - `ignoredProgrammaticScrollTopRef`
  - `userScrollIntentDeadlineRef`
  - `lastSettledScrollTopRef` / `hasSettledFollowFrameRef`
- Illegal combinations are only guarded by runtime branching, not by type.
- Unit tests of the combined mode machine still require the React component surface.

T8 goal: one pure runtime state machine that can be unit-tested without DOM/React, while TerminalView only applies effects.

## 3. Target state model

```ts
type TerminalFollowScrollState =
  | { phase: 'idle-follow'; lastSettledScrollTop: number; hasSettledFollowFrame: boolean; userScrollIntentUntil: number }
  | { phase: 'programmatic-scroll'; targetScrollTop: number; lastSettledScrollTop: number; hasSettledFollowFrame: boolean; userScrollIntentUntil: number; pendingRenderBottomIndex: number | null; guardPendingFollowDrift: boolean }
  | { phase: 'pending-follow-sync'; pendingRenderBottomIndex: number; lastQueuedRenderBottomIndex: number; lastSettledScrollTop: number; hasSettledFollowFrame: boolean; userScrollIntentUntil: number; guardPendingFollowDrift: boolean; immediate: boolean }
  | { phase: 'layout-settling'; lastSettledScrollTop: number; hasSettledFollowFrame: boolean; userScrollIntentUntil: number; pendingViewportRealign: boolean }
  | { phase: 'user-scroll-intent'; lastSettledScrollTop: number; hasSettledFollowFrame: boolean; userScrollIntentUntil: number }
  | { phase: 'reading'; lastSettledScrollTop: number; hasSettledFollowFrame: boolean; userScrollIntentUntil: number };
```

Effects produced by transitions (executed only by TerminalView / DOM adapters):

- `scheduleTimeout(flushPending)`
- `cancelTimeout`
- `setScrollTop(target)`
- `setReadingMode(boolean)`
- `setRenderBottomIndex(number)`
- `emitViewportDemand(mode, renderBottomIndex)`
- `markRecentLayoutChange(duration)`

## 4. Transition table

| From | Event | To | Effects | Positive lock | Negative lock |
|---|---|---|---|---|---|
| idle-follow | queueFollowSync(target) | pending-follow-sync | scheduleTimeout | same target does not schedule second timer | reading mode does not queue follow sync |
| pending-follow-sync | flush | programmatic-scroll then idle-follow | setScrollTop, clear pending | flush applies pending render bottom | flush while reading is no-op |
| idle-follow / pending | commitProgrammatic(target) | programmatic-scroll -> idle-follow | suppress onScroll once, setScrollTop | onScroll during suppress ignored | suppress must not stick after commit |
| idle-follow | userWheel/touch intent | user-scroll-intent | mark deadline | later user scroll may enter reading | layout/programmatic scroll alone must not enter reading |
| user-scroll-intent | scroll away from bottom | reading | setReadingMode true, emit reading demand | only user intent enters reading | IME/layout drift must remain follow |
| reading | explicit follow reset / input reset | idle-follow | setReadingMode false, queue sync | input reset realigns follow | passive buffer apply must not force reading exit without reset |
| idle-follow | viewport layout drift | layout-settling | pendingViewportRealign true | layout guard queues realign | layout guard must not mark user intent |
| layout-settling / pending | observed non-bottom without upward user move | pending-follow-sync(guard) | queue realign | temporary DOM not-at-bottom stays follow | upward user move can still enter reading |
| any | cancel/session switch | idle-follow defaults | cancel timers, clear pending | switch clears all pending timers | leftover timer must not fire into new session |

## 5. Required white-box tests

1. Pure state transitions for every row above with frozen timestamps.
2. Illegal phase combinations unrepresentable: no `connecting+timer` analogue; specifically no `reading + pendingFollowScrollSync timer`.
3. Programmatic suppress is one-shot: after commit, next real user scroll is accepted.
4. Pending sync de-dupes identical target; different target replaces pending index without stacking timers.
5. Cancel clears timer, pending indexes, layout flags, ignored programmatic target.

## 6. Required black-box / component tests

Existing must stay green:

- `TerminalView.dynamic-refresh.test.tsx`
- multi-pane / follow reset related TerminalView tests

New or strengthened component gates:

1. Follow live tail: buffer growth keeps bottom without entering reading.
2. User upward scroll enters reading and holds renderBottomIndex.
3. Programmatic realign after layout/IME height change does not enter reading.
4. Input/follow reset returns reading -> follow and scrolls to bottom.
5. Session switch cancels pending follow timer from previous session.

## 7. Live terminal-buffer-truth loop

After pure + component green:

1. Use existing daemon/tmux mirror source.
2. Follow mode: continuous output stays bottom-aligned.
3. Manual scroll up: reading holds; live output does not yank back.
4. Enter key / follow reset: returns to bottom.
5. IME open/close on Android: layout drift does not flip to reading.

No live proof => T8 not closed.

## 8. Implementation order

1. Land this test design.
2. Add pure runtime + red tests for transitions.
3. Migrate TerminalView to one state ref + effect applicator.
4. Keep shared math helpers; do not reimplement scrollTop/target math.
5. Run TerminalView suite + feature-registry + type-check.
6. Run terminal-buffer-truth live loop before claiming closeout.

## 9. DoD

- TerminalView no longer owns the scattered follow flag bag as independent product truth.
- Pure runtime tests cover positive and negative transitions.
- Dynamic-refresh suite green.
- Live follow/reading hand-feel verified or explicit residual risk listed.
