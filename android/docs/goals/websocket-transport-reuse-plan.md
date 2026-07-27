# WebSocket Transport Reuse Plan

Date: 2026-07-07

## Goal And Acceptance

Goal: implement Android terminal WebSocket reuse so foreground resume, tab switch, explicit resume, and reconnect requests reuse the existing daemon-target physical transport when it is still valid, instead of rebuilding sockets.

Acceptance:
- Same session + same bridge target + usable session WebSocket does not create a second session WebSocket.
- Foreground resume and tab switch are fast because they use cached runtime truth first, then request head only when needed.
- Closed, failed, stale-pending, target-mismatch, or manually disconnected transports still reopen through the existing reconnect path.
- No inactive/background continuous refresh is introduced.
- No daemon mirror, buffer apply, renderer follow, file transfer, image paste, or UI shell behavior is changed.
- A new APK is built after implementation for device testing.

## Scope

In scope:
- Android `terminal.transport_lifecycle`.
- `SessionContext` transport freshness/open/reconnect decision flow.
- Pure helper tests, runtime tests, and `SessionContext.ws-refresh` integration tests.
- Function map / test design / note updates if owner or gate mapping changes.

Out of scope:
- daemon mirror publish strategy.
- client buffer manager sparse-buffer merge.
- renderer visible-window/follow behavior.
- inactive session live buffer churn.
- App / TerminalPage / drawer owned WebSocket logic.
- long-lived background refresh as a substitute for transport reuse.

## Architecture Mapping

Feature id: `terminal.transport_lifecycle`.

Canonical docs:
- `android/docs/architecture.md`
- `android/docs/audits/2026-07-02-architecture-boundary-remediation.md`
- `android/docs/decisions/2026-04-28-terminal-transport-session-lifecycle-truth.md`
- `.agents/skills/terminal-buffer-truth/SKILL.md`
- `android/docs/function-map.md`
- `android/docs/feature-gates.md`

Owner boundary:
- Freshness owner: `SessionContext -> ensureActiveSessionFresh / buildActiveSessionRefreshPlan`.
- Transport lifecycle owner: `src/contexts/session-context-transport-runtime.ts` and adjacent `src/contexts/session-context-transport-*.ts` runtime modules.
- Session lifecycle primitive owner: `src/contexts/session-context-session-runtime.ts`.
- UI orchestration owners may pass intent only; they must not decide socket reuse.

Architecture rule:

```text
same session transport still alive?
  -> reuse same session transport
session transport dead but control transport alive?
  -> rebuild same session transport
control transport dead?
  -> reconnect control transport
  -> re-attach same clientSessionId
  -> rebuild same session transport
```

Forbidden:

```text
cleanup old socket
-> fresh ws
-> fresh connect
-> pretend it is the same session
```

## Technical Plan

### Current Risk Points

- `connectSessionRuntime()` currently clears reconnect, calls `cleanupSocket(sessionId, false)`, then queues a connect open intent. This can rebuild even when the same target session transport is already open or connecting.
- `reconnectSessionRuntime()` currently clears reconnect, calls `cleanupSocket(sessionId, false)`, updates state to reconnecting, then schedules forced reconnect. This can rebuild even when the socket is still open and usable.
- `client.daemon_connection.openSessionTargetTransport()` currently calls `cleanupSocket(sessionId, false)` only when the target transport is genuinely dead or mismatched. It must not be used to recreate an already-usable daemon-target transport.
- `buildActiveSessionRefreshPlan()` already handles open sockets well for freshness paths, but explicit connect/reconnect primitives do not yet share the same reuse guard.

### Implementation Shape

Add one pure transport reuse planner and route all rebuild decisions through it.

Proposed helper:
- Location: `src/contexts/session-transport-open-helpers.ts` unless a narrower adjacent helper is cleaner.
- Name: `buildSessionTransportReusePlan` or equivalent.
- Inputs:
  - session exists / manual closed
  - current target key
  - requested target key
  - current socket readyState
  - pending open exists / stale
  - reconnect runtime timer / connecting
  - source: `connect | reconnect | open-intent | explicit-resume | active-reentry | active-resume | input`
- Outputs:
  - `reuse-open`
  - `wait-existing-open`
  - `skip-manual-closed`
  - `rebuild-closed`
  - `rebuild-stale-pending`
  - `rebuild-target-mismatch`
  - `rebuild-missing`

Expected side effects by plan:
- `reuse-open`: do not call `cleanupSocket`, do not queue open intent, request forced head through freshness owner when needed.
- `wait-existing-open`: do not call `cleanupSocket`, do not queue another open intent.
- `skip-manual-closed`: do not reconnect.
- `rebuild-*`: existing connect/reconnect/open path may proceed.

### File List

Likely changed:
- `android/src/contexts/session-transport-open-helpers.ts`
- `android/src/contexts/session-context-session-runtime.ts`
- `android/src/contexts/session-context-session-orchestration-runtime.ts` only if helper dependencies must be wired.
- `android/src/contexts/session-context-transport-open-runtime.ts`
- `android/src/contexts/session-context-activity-runtime.ts` only if stale reconnect in-flight semantics need correction.
- `android/src/contexts/session-sync-helpers.test.ts`
- `android/src/contexts/session-context-session-runtime.test.ts`
- `android/src/contexts/SessionContext.ws-refresh.test.tsx`
- `android/docs/testing/websocket-transport-reuse-test-design.md`
- `android/note.md`
- `android/MEMORY.md` only after verified conclusion.

Do not change:
- `android/src/App.tsx`
- `android/src/pages/TerminalPage.tsx`
- `android/src/components/terminal/TerminalSessionDrawer.tsx`
- daemon mirror/live sync files
- buffer/render files
- file transfer/image paste files

## Risk And Controls

Risk: incorrectly skipping reconnect when the socket is actually dead.
Control: negative tests for `CLOSED`, `CLOSING`, missing socket, stale pending open, target mismatch, and manual close.

Risk: keeping a socket open but failing to request fresh head.
Control: runtime/integration tests assert `requestSessionBufferHead` or expected head request is sent on explicit resume / active resume / active reentry with an open transport.

Risk: connecting transport gets stuck because duplicate open is suppressed.
Control: only fresh pending open suppresses duplicate queue; stale pending open remains rebuildable.

Risk: state label says reconnecting while socket is open.
Control: reuse plan must treat socket truth as transport truth and not rebuild solely because `session.state` is stale.

Risk: App/UI grows a second transport policy.
Control: keep changes in SessionContext transport/session runtime files; run architecture boundary gate.

## Test Plan

### L0 Static / Architecture

- `pnpm --dir android run test:feature-registry -- --reporter dot`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `git diff --check`

### L1 Pure Helper And Runtime Tests

Add or update pure tests:
- same target + OPEN + explicit resume -> reuse/request-head, not reconnect.
- same target + OPEN + reconnect request -> reuse, no cleanup/open queue.
- same target + CONNECTING + fresh pending open -> wait, no duplicate queue.
- same target + pending open stale -> rebuild.
- CLOSED/CLOSING/null socket -> rebuild when reconnect is allowed.
- target mismatch -> rebuild.
- manual close -> skip.

Add or update runtime tests:
- `connectSessionRuntime()` does not cleanup or queue a new open when the same target socket is `OPEN`.
- `connectSessionRuntime()` waits when the same target has `CONNECTING` plus fresh pending open.
- `reconnectSessionRuntime()` does not cleanup or schedule forced reconnect when the same target socket is `OPEN`.
- `client.daemon_connection.openSessionTargetTransport()` does not replace a still-usable current daemon-target transport.
- closed/stale/target-mismatch cases still rebuild.

### L3 SessionContext Integration

Add `SessionContext.ws-refresh.test.tsx` coverage:
- foreground resume with existing open socket keeps `MockWebSocket.instances.length` unchanged and sends a head request.
- tab switch to an already connected session keeps the same session socket instance.
- explicit reconnect call while socket is still open does not create a second WebSocket.
- input with open socket sends on existing socket even if session label is stale.
- socket closed path still creates a new session WebSocket.

### L4 App Shell Regression

Run existing focused gates that cover open-tab restore/resume and tab switch:
- `SessionContext.ws-refresh.test.tsx`
- `useOpenTabRuntime.test.tsx`
- `useOpenTabSessionActions.test.tsx` or current matching open-tab action tests.
- Any existing `App` tab switch / dynamic refresh tests that assert reconnect behavior.

### L5 Package

After tests pass:
- `./android/scripts/build-android-debug.sh`
- Publish generated APK into `android/update-dist/`.
- Report APK path, version, versionCode, sha256, and the exact verification level.

Device validation remains Jason-side unless a connected Android device is available to the agent. Do not claim device closure without real device evidence.

## Implementation Steps

1. Re-read canonical docs, MemoryPalace, function map, and current source before editing.
2. Create `android/docs/testing/websocket-transport-reuse-test-design.md`.
3. Add failing tests for pure planner and runtime duplicate-rebuild cases.
4. Implement the pure reuse planner.
5. Wire the planner into `connectSessionRuntime`, `reconnectSessionRuntime`, and `client.daemon_connection.openSessionTargetTransport` without touching UI.
6. Run targeted tests until green.
7. Run feature registry, typecheck, and diff check.
8. Build Android debug APK.
9. Update `note.md`; promote only verified durable conclusions to `MEMORY.md`.
10. Commit scoped changes only after verification.

## Definition Of Done

- Same-target usable session WebSocket is reused across foreground resume, active reentry, explicit resume, connect, and reconnect requests.
- Duplicate session WebSocket creation is locked by tests.
- Broken transport still reconnects.
- No inactive/background continuous refresh is introduced.
- Owner boundary remains inside SessionContext transport/session runtime.
- Targeted tests, architecture gate, typecheck, and Android debug build pass.
- New APK is available for Jason to install and test.
