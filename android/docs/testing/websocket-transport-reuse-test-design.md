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
-> request head / explicit resume session-open only when no usable socket exists
```

## L1 Pure Planner Cases

Positive reuse:
- Same target + `WebSocket.OPEN` + connect source returns `reuse-open`.
- Same target + `WebSocket.OPEN` + reconnect source returns `reuse-open`.
- Same target + `WebSocket.CONNECTING` + fresh pending open returns `wait-existing-open`.
- Foreground false->true is mapped to `explicit-resume`; it must share the cold-start/explicit resume transport owner instead of owning a separate `active-resume` branch.
- Explicit resume with an over-budget pending open still returns `skip/transport-open-pending`; it must not create a second WebSocket.
- Explicit resume with an over-budget `WebSocket.CONNECTING` session socket after the control intent has settled still returns `skip/transport-open-pending`; it must not create a second WebSocket.
- Explicit resume with stale reconnect bookkeeping still returns skip/wait when a current pending/connecting socket exists; local `reconnectRuntime.connecting` is not transport failure truth and must not create a second WebSocket.

Positive rebuild:
- Same target + `WebSocket.CLOSED` returns `rebuild-closed`.
- Same target + `WebSocket.CLOSING` returns `rebuild-closed`.
- Missing socket returns `rebuild-missing`.
- Same target + stale pending open still returns `wait-existing-open`; stale bookkeeping is not socket failure truth.
- Target mismatch returns `rebuild-target-mismatch`.

Negative:
- Manual close returns `skip-manual-closed` and must not queue reconnect.
- Stale `session.state` labels such as `reconnecting` must not force rebuild when socket truth is `OPEN`.
- Stale activity / missed pong / pong-only traffic must not force rebuild when socket truth is `OPEN`; they may only send ping or request head on the same transport.
- Same-socket `buffer-head-request` timeout must not force rebuild when socket truth is still `OPEN`; it may clear the stale probe marker and send another head request on the same socket.
- Fresh initial connect pending open still waits and does not create a duplicate socket.
- Fresh `WebSocket.CONNECTING` session socket after the control intent has settled still waits and does not create a duplicate socket before the active wait budget expires.
- Active tick, explicit resume, and active reentry all must not force-replace a pending or `CONNECTING` socket solely because a wait budget elapsed.
- Stale reconnect bookkeeping must not be treated as socket failure. The only allowed rebuild reasons are physical close/error, target mismatch, explicit user reconnect/open, or missing/closed socket in an explicit open/resume path.

## L1 Runtime Cases

`connectSessionRuntime()`:
- Given same target and `OPEN` socket, it must not call `cleanupSocket` or `queueConnectTransportOpenIntent`.
- Given same target and `CONNECTING` plus fresh pending open, it must not call `cleanupSocket` or queue another open.
- Given closed/missing socket, it still primes host state and queues connect.

`reconnectSessionRuntime()`:
- Given same target and `OPEN` socket, it must not call `cleanupSocket` or `scheduleReconnect`.
- Given same target and `CONNECTING` plus fresh pending open, it must not call `cleanupSocket` or `scheduleReconnect`.
- Given same target and `CONNECTING` plus fresh pending open, it must update visible session state to `reconnecting` with a waiting message.
- Given explicit resume marks a pending open as stale under the active wait budget, `ensureActiveSessionFreshRuntime()` must keep waiting on the same socket and must not call `reconnectSession`.
- Given explicit resume sees an over-budget `WebSocket.CONNECTING` session socket after `session-ticket` cleared the pending open, `ensureActiveSessionFreshRuntime()` must keep waiting on the same socket and must not call `reconnectSession`.
- Given explicit resume sees stale reconnect runtime bookkeeping but no current socket/pending open, `ensureActiveSessionFreshRuntime()` may call the unique reconnect owner; stale bookkeeping alone must not create a second socket while a current socket exists.
- Force replacement is not a lifecycle/probe/input/foreground/online recovery API.
- Given an `OPEN` socket with an expired head probe marker, `ensureActiveSessionFreshRuntime()` must request head again on the same socket and must not call `reconnectSession`.
- Given closed/missing socket, it still schedules immediate reconnect.
- Given manual close, it must skip reconnect.

`openSessionTransportByIntentRuntime()`:
- Given current same-target session socket is `OPEN`, it must not cleanup or build a second session socket.
- Given current same-target session socket is `CONNECTING`, it must not cleanup or build a second session socket.
- Given target mismatch, closed socket, or missing socket, it may cleanup and build a new session socket.

## L3 SessionContext Cases

`SessionContext.ws-refresh.test.tsx`:
- Foreground false -> true with an already open active session keeps `MockWebSocket.instances.length` unchanged and sends a head request on the existing socket.
- Foreground false -> true with a stale `CONNECTING` active session socket keeps `MockWebSocket.instances.length` unchanged and does not close the pending socket.
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
