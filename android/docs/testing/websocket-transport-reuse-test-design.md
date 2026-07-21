# WebSocket Transport Reuse Test Design

Date: 2026-07-07
Feature: `terminal.transport_lifecycle`

## Objective

Lock the Android client transport rule that a same-session, same-target usable WebSocket is reused across foreground resume, tab switch, explicit resume, connect, and reconnect paths. Rebuild is allowed only when transport truth says it is necessary.

Next architecture step: replace per-session physical body sockets with one daemon-target physical transport plus per-session logical channels. Relay/WebRTC recovery must be target-scoped too: a valid idle-timeout Relay peer lease may resume a physical daemon-target route, but it cannot preserve or infer terminal channel/session/tmux/UI truth.

## Architecture Boundary

Owner:
- `src/contexts/session-transport-open-helpers.ts`
- `src/contexts/session-context-session-runtime.ts`
- `src/contexts/session-context-transport-open-runtime.ts`
- `src/contexts/session-context-activity-runtime.ts`
- `src/lib/tmux-sessions.ts` for target-scoped tmux management control transports
- `src/lib/session-transport-runtime.ts` for daemon-target transport and channel runtime truth
- `packages/shared/src/connection/protocol.ts` for mux frame contracts
- `src/server/terminal-daemon-runtime.ts` for daemon-side physical transport liveness
- `src/server/terminal-runtime.ts` / `src/server/terminal-mirror-runtime.ts` for subscriber detach and adaptive width lease release
- `src/traversal-relay/server.ts` / `src/server/relay-client.ts` / `src/server/rtc-bridge.ts` for Relay peer lease resume truth

Forbidden test targets:
- `src/App.tsx`
- `src/pages/TerminalPage.tsx`
- `src/components/terminal/TerminalSessionDrawer.tsx`
- daemon mirror/live sync modules
- buffer/render modules

The UI may trigger resume/switch intent, but tests must prove socket reuse is owned below the UI layer.

Tmux management requests are a separate control lane. Because the daemon response has no request id, one target-scoped `TraversalSocket` must serialize requests FIFO. Successful responses and request-level daemon errors keep that physical socket reusable; physical close/error, malformed protocol data, or request timeout removes and closes it. The pool caches no session-list result.

Daemon stale physical transport cleanup is separate from client foreground/tab policy. It may close and detach only a session transport whose bound subscriber has no inbound heartbeat/message past the fixed transport liveness window. It must not destroy the tmux session, destroy mirror truth, infer client active/background state, or close idle control transports.

Multiplex resource path:

```text
active session
-> session transport owner
-> daemon-target physical transport
-> terminal channel
-> daemon subscriber
-> mirror store
-> client sparse buffer
```

Relay resume resource path:

```text
daemon-target physical transport
-> relay peer lease
-> transport target
```

Relay peer lease is route/signaling truth only. It must not connect directly to terminal channel, transport subscriber, tmux, mirror, renderer, active tab, foreground, viewport, or UI projection truth.

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
- Foreground resume and active reentry must reuse only real `OPEN` / `CONNECTING` transport truth. `SESSION_TRANSPORT_KEEPALIVE_GRACE_MS` is diagnostic context only; it must not convert missing/closed local transport truth into a fake reusable connection. Closed/missing socket still enters the unique reconnect owner. Active tick / explicit input recovery keeps the existing immediate recovery path.

## L1 Runtime Cases

`connectSessionRuntime()`:
- Given same target and `OPEN` socket, it must not call `cleanupSocket` or `queueConnectTransportOpenIntent`.
- Given same target and `CONNECTING` plus fresh pending open, it must not call `cleanupSocket` or queue another open.
- Given closed/missing socket, it still primes host state and queues connect.
- Given the same local session retargets from a direct route to a Relay-aware route, the existing active socket must be removed from the new runtime's active socket truth and moved into superseded truth; it must not remain the new target's active socket.

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
- Given closed/missing socket with recent server activity or connected baseline inside the keepalive grace window, it must call the unique reconnect owner because no live socket can be reused.
- Given the same unavailable socket after the keepalive grace window expires, it must call the same unique reconnect owner.
- Given reconnect already in flight inside the grace window, it must keep the existing in-flight behavior and must not queue a duplicate reconnect.
- Given manual close, it must skip reconnect.

`openSessionTransportByIntentRuntime()`:
- Given current same-target session socket is `OPEN`, it must not cleanup or build a second session socket.
- Given current same-target session socket is `CONNECTING`, it must not cleanup or build a second session socket.
- Given target mismatch, closed socket, or missing socket, it may cleanup and build a new session socket.
- Same-target must be route-aware: a Tailscale/direct WebSocket target and a Relay/WebRTC-capable target for the same daemon/bridge host must produce different target keys, so restore/reconnect cannot reuse the wrong control/session transport merely because `bridgeHost:bridgePort:authToken` matches.
- When Home/Relay reopens an already-open session through a route-aware target, the session-open owner must rebind the session by calling `createSession(..., { sessionId: existingId, activate: false })` before explicit-resume. UI-only reuse is not enough.
- Route-aware target keys must ignore volatile directory timestamps such as `lastSeenAt`; endpoint kind/host/port/wsUrl/relay identity and transport mode are semantic, timestamp freshness is not.
- Given a route-aware Relay Host plus a legacy provider `wsUrl`, `buildTraversalSocketForHostRuntime()` must not pass the override into `TraversalSocket`; the resulting plan must still include direct LAN/Tailscale candidates before WebRTC direct and TURN/Relay candidates.
- Given a legacy non-relay Host plus a provider `wsUrl`, the same factory may pass the role-scoped override for compatibility.
- Given an opened WebRTC transport, `applyTransportDiagnosticsRuntime()` must project the actual selected ICE pair metadata from `TraversalSocket.getDiagnostics()` without reading daemon/client target metadata as route truth.

`createTerminalDaemonRuntime().startHeartbeatLoop()`:
- Positive: a bound RTC/Relay session transport with no inbound heartbeat/message for more than the server stale window is closed, removed from `connections`, and detached through `detachSubscriberTransportOnly`.
- Positive: the detach path releases adaptive width ownership through the existing mirror owner, so `resize-window -x <baseline>` and `set-window-option -u window-size` happen only when the subscriber held a live adaptive lease.
- Negative: a bound RTC/Relay session transport that keeps receiving client `ping`/message activity every 2 seconds is not closed or detached.
- Negative: stale cleanup must not call `destroyMirror`, `closeTransportSubscriber`, or any tmux session kill path; it only releases the physical transport/subscriber and leaves backend session truth intact.
- Negative: unbound control/pending transports are not classified as Android terminal session occupation and are not closed by the session stale cleanup rule.

## L1 Multiplex Protocol And Channel Cases

Protocol:
- Positive: `mux-hello` / `mux-ready` parse and build accepts only the supported version and capability set.
- Positive: `mux-channel-message` wraps each existing session-bound payload with a non-empty `channelId`.
- Negative: unwrapped session-bound payload on the new Android mux path returns explicit `daemon_multiplex_upgrade_required` or `mux_unwrapped_session_message`, never a silent legacy fallback.
- Negative: unknown channel, duplicate open, channel id mismatch, and target-message carrying session-bound payload all produce explicit mux errors and do not mutate buffer/input/file/schedule state.

Android target runtime:
- Positive: opening ten sessions for one route-aware daemon target constructs one physical target transport and ten terminal channel entries.
- Positive: switching sessions and foreground resume while the physical target transport is `OPEN` sends channel body-subscription/head/ping only, not a new WebSocket/RTC connection.
- Negative: a closed physical target transport cannot be treated as reusable because channel state still exists; the unique reconnect owner must rebuild or resume the target transport first.
- Negative: one channel close removes only that channel/subscriber binding and does not close other channels or the physical target transport.

Daemon channel registry:
- Positive: each `mux-channel-open` creates one subscriber binding and returns `mux-channel-opened` with the same `channelId`.
- Positive: `body-subscription=false` for inactive channels removes live body push eligibility while explicit head/range remains valid.
- Negative: physical target close detaches every channel subscriber and releases adaptive leases through the existing owner, but does not kill tmux or destroy mirror truth.
- Negative: late mirror body for a closed channel is dropped with explicit channel-closed accounting and cannot be delivered under another channel id.

Send scheduler:
- Positive: P0 open/close/error/input-ack/pong frames outrank body frames.
- Positive: body frames are pending-latest per channel; repeated TUI refreshes for one channel cannot enqueue unbounded old bodies.
- Negative: heavy body traffic on preview channels cannot starve active channel input ack/head responses.

## L1 Relay Peer Lease Resume Cases

Relay server:
- Positive: after a client signaling socket closes, a valid lease remains until idle timeout and the server does not send `relay-peer-close` to daemon immediately.
- Positive: reconnecting with the same account, hostId, client device id, and valid `relayResumeToken` rebinds the client socket to the existing peer lease.
- Negative: expired token, mismatched account/host/device, host offline, and replaced daemon host socket fail explicitly and close the stale peer.
- Negative: peer lease state contains only route/signaling metadata and never stores channel id, sessionName, tmux id, mirror revision, active tab, foreground, viewport, renderer state, or terminal payload.

Daemon relay client / RTC bridge:
- Positive: phone signaling close before idle timeout marks the peer idle but does not close RTCPeerConnection or delete peer truth.
- Positive: lease expiry or host disposal closes and deletes the peer exactly once.
- Negative: resuming a relay peer must not create a second terminal channel or subscriber when mux target transport is still valid.

## L3 SessionContext Cases

`SessionContext.ws-refresh.test.tsx`:
- Foreground false -> true with an already open active session keeps `MockWebSocket.instances.length` unchanged and sends a head request on the existing socket.
- Foreground false -> true within the keepalive grace window after recent server activity keeps `MockWebSocket.instances.length` unchanged even when the local socket is unavailable; reconnect is allowed only after the grace window expires.
- Foreground false -> true with a stale `CONNECTING` active session socket keeps `MockWebSocket.instances.length` unchanged and does not close the pending socket.
- Switching back to an already connected session keeps that session's socket instance stable.
- Clicking explicit reconnect while the session socket is still open does not create a second session WebSocket.
- Sending input while the socket is open uses the existing socket even if the session label is stale.
- Closing the socket and then reconnecting still creates a new socket.

## L1 Tmux Management Control Cases

- Positive: sequential list/create/kill operations for the same normalized target reuse one `TraversalSocket` and each operation receives its own current daemon response.
- Positive: concurrent calls for one target are sent FIFO and only the active request consumes the next uncorrelated response.
- Positive: a daemon `error` response rejects only the active request and leaves the physical socket available for the next request.
- Negative: different target or Relay account identity must never share a control socket.
- Negative: physical error/close, malformed response, unexpected response type, or timeout must reject pending work and evict the socket before a later request creates a new one.
- Negative: no successful sessions payload is cached or returned without a fresh request/response exchange.

## Verification Commands

Targeted:
- `pnpm --dir android exec vitest run src/lib/tmux-sessions.test.ts src/contexts/session-sync-helpers.test.ts src/contexts/session-context-session-runtime.test.ts src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot`
- `pnpm --dir android exec vitest run src/server/terminal-daemon-runtime.test.ts src/server/terminal-runtime.detached-session.test.ts src/server/server.daemon-runtime-truth.test.ts src/server/server.transport-lifecycle-truth.test.ts --reporter dot`

Architecture/static:
- `pnpm --dir android run test:feature-registry -- --reporter dot`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `git diff --check`

Package:
- `./android/scripts/build-android-debug.sh`

## Known Non-Claims

Passing L1/L3 proves client transport runtime semantics in test environment. It does not prove true packaged Android WebView behavior until the generated APK is installed and tested on device.
