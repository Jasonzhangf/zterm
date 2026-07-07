# WebSocket Transport Reuse Test Design

Date: 2026-07-07
Feature: `terminal.transport_lifecycle`

## Objective

Lock the Android client transport rule that a same-session, same-target usable WebSocket is reused across foreground resume, tab switch, explicit resume, connect, and reconnect paths. Rebuild is allowed only when transport truth says it is necessary.

## Architecture Boundary

Owner:
- `src/contexts/session-transport-open-helpers.ts`
- `src/contexts/session-context-session-runtime.ts`
- `src/contexts/session-context-transport-open-runtime.ts`
- `src/contexts/session-context-activity-runtime.ts`

Forbidden test targets:
- `src/App.tsx`
- `src/pages/TerminalPage.tsx`
- `src/components/terminal/TerminalSessionDrawer.tsx`
- daemon mirror/live sync modules
- buffer/render modules

The UI may trigger resume/switch intent, but tests must prove socket reuse is owned below the UI layer.

## Mainline Under Test

```text
open-tab intent / foreground lifecycle / input
-> SessionContext freshness or session primitive
-> transport reuse planner
-> reuse existing session WebSocket OR queue one rebuild
-> request head / reconnect / session-open
```

## L1 Pure Planner Cases

Positive reuse:
- Same target + `WebSocket.OPEN` + connect source returns `reuse-open`.
- Same target + `WebSocket.OPEN` + reconnect source returns `reuse-open`.
- Same target + `WebSocket.CONNECTING` + fresh pending open returns `wait-existing-open`.
- Explicit/foreground active resume with an over-budget pending open returns `reconnect` with `forceReplaceTransport`.

Positive rebuild:
- Same target + `WebSocket.CLOSED` returns `rebuild-closed`.
- Same target + `WebSocket.CLOSING` returns `rebuild-closed`.
- Missing socket returns `rebuild-missing`.
- Same target + stale pending open returns `rebuild-stale-pending`.
- Target mismatch returns `rebuild-target-mismatch`.

Negative:
- Manual close returns `skip-manual-closed` and must not queue reconnect.
- Stale `session.state` labels such as `reconnecting` must not force rebuild when socket truth is `OPEN`.
- Fresh initial connect pending open still waits and does not create a duplicate socket.
- Active tick still skips blocking pending opens; only explicit resume / active resume / active reentry may force-replace after the short active wait budget.

## L1 Runtime Cases

`connectSessionRuntime()`:
- Given same target and `OPEN` socket, it must not call `cleanupSocket` or `queueConnectTransportOpenIntent`.
- Given same target and `CONNECTING` plus fresh pending open, it must not call `cleanupSocket` or queue another open.
- Given closed/missing socket, it still primes host state and queues connect.

`reconnectSessionRuntime()`:
- Given same target and `OPEN` socket, it must not call `cleanupSocket` or `scheduleReconnect`.
- Given same target and `CONNECTING` plus fresh pending open, it must not call `cleanupSocket` or `scheduleReconnect`.
- Given same target and `CONNECTING` plus fresh pending open, it must update visible session state to `reconnecting` with a waiting message.
- Given active resume marks a pending open as stale under the active wait budget, `ensureActiveSessionFreshRuntime()` must call `reconnectSession(sessionId, { forceReplaceTransport: true })`.
- Given closed/missing socket, it still schedules immediate reconnect.
- Given manual close, it must skip reconnect.

`openSessionTransportByIntentRuntime()`:
- Given current same-target session socket is `OPEN`, it must not cleanup or build a second session socket.
- Given current same-target session socket is `CONNECTING`, it must not cleanup or build a second session socket.
- Given target mismatch, closed socket, or missing socket, it may cleanup and build a new session socket.

## L3 SessionContext Cases

`SessionContext.ws-refresh.test.tsx`:
- Foreground false -> true with an already open active session keeps `MockWebSocket.instances.length` unchanged and sends a head request on the existing socket.
- Switching back to an already connected session keeps that session's socket instance stable.
- Clicking explicit reconnect while the session socket is still open does not create a second session WebSocket.
- Sending input while the socket is open uses the existing socket even if the session label is stale.
- Closing the socket and then reconnecting still creates a new socket.

## Verification Commands

Targeted:
- `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts src/contexts/session-context-session-runtime.test.ts src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot`

Architecture/static:
- `pnpm --dir android run test:feature-registry -- --reporter dot`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `git diff --check`

Package:
- `./android/scripts/build-android-debug.sh`

## Known Non-Claims

Passing L1/L3 proves client transport runtime semantics in test environment. It does not prove true packaged Android WebView behavior until the generated APK is installed and tested on device.
