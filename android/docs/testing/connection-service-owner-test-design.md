# Connection Service Owner Migration Test Design

Date: 2026-08-18
Feature: `client.android_connection_service`
Owner module: `client.connection_service` (status: `active`; native WebSocket slice implemented, native WebRTC/Relay backend is part of this route-policy task)

## Scope

The migration must make `AndroidConnectionService` the sole owner of the physical WebSocket, route/auth, mux/channel, heartbeat, network-generation, reconnect/backoff, and connection-generation truth. Activity, WebView, and React may only consume snapshots/events and send explicit typed commands.

WebRTC remains inside the same `AndroidConnectionService` physical-target lifecycle owner. A native WebRTC backend may own only signaling/ICE/DataChannel mechanics for one candidate attempt; it must not own route ranking, target generation, mux/channel registry, heartbeat, reconnect/backoff, UI state, or Relay directory truth.

The service projection carries the exact `mux-ready` payload and target generation. A late WebView listener replays the current healthy projection without opening a second physical transport or sending a JS mux hello.

Foreground resume is a data-refresh trigger only. On Android it may refresh the Relay/control directory and request `buffer-head` plus the missing body range over an already-open projected channel. It must not emit `notifyTargetNetworkSignal`, resample transport identity, reopen a channel, reconnect a target, or start/stop the service. When the projected socket/channel is unavailable, the UI skips the refresh and waits for the service-owned snapshot/event path.

## Required Gates

1. `pnpm --dir android run test:feature-registry`
2. `pnpm --dir android run test:transport-network-lifecycle`
3. `pnpm --dir android run test:android-connection-service`
4. `pnpm --dir android run test:android-connection-service:native`
5. `pnpm --dir android run type-check`
6. `pnpm --dir android run build`
7. `pnpm --dir android run build:android`
8. Real ADB online regression when an online device exists.

## Test Layers

### JS exact-channel input readiness candidate

The channel runtime owns an explicit `terminal-connected` input policy for the
exact Rex lane. Shared Host/backend types do not yet include Rex; combination
must wire this policy from the real typed Host. Exact tmux/Herdr opens retain
their default ACK-ready input behavior.

Inject mux frames through the current socket's actual onmessage handler and
capture the final wrapped socket send. A matching opened ACK must permit body
subscription/control while reliable input stays queued. Pre-admission connected,
buffer messages, stale socket frames and retired/rejected attempts cannot release
input. Current admitted connected releases queued input once; duplicates do not
resend it. Verify typed, raw and pre-wrapped input at the final send boundary,
ordinary-input drop semantics, and default tmux/Herdr behavior. No live Rex or
Android acceptance follows from this in-process fixture.

### State machine and snapshot

`src/lib/android-connection-service-snapshot.test.ts` must cover:

- `Idle -> ResolvingTarget -> Connecting -> MuxReady -> ChannelsReady -> Healthy`.
- Physical close -> `BackoffReconnect`; the next attempt is service-timer-owned.
- Valid pong/activity keeps `Healthy`.
- Three missed heartbeats force one generation retirement and backoff.
- Authentication failure enters `AuthenticationError` and does not auto-reconnect.
- Terminal failure releases the target explicitly.
- Late frames from an old generation are rejected and cannot update the current snapshot.
- Repeated identical bind/policy commands are idempotent.
- Auto candidate order is eligible same-subnet LAN, Tailscale, verified public direct, then TURN Relay.
- A fresh confirmed Relay directory may update a future target generation without replacing a healthy current generation.

### Typed control/projection boundary

`src/lib/android-connection-service-commands.test.ts` and `src/plugins/AndroidConnectionServicePlugin.test.ts` must prove:

- The only UI behavior-changing command is `SetManualRoutePolicy`.
- The only other mutating commands are typed `BindTarget` and `ReleaseTarget`.
- `allowReconnectIfUnavailable`, `fingerprintChanged`, `notifyTargetNetworkSignal`, and UI lifecycle state are not accepted as service commands.
- Snapshot/event values remain on the control/projection side-channel and never enter terminal body, `buffer-sync`, input, file, remote-window, or metadata payloads.
- Target control frames preserve `requestId` and typed `message` through `target-message` IPC into native `mux-target-message`; malformed target commands reject explicitly.
- The bridge schedules no JS heartbeat/reconnect timer and does not call `evaluateJavascript`.

### UI projection runtime

`src/contexts/android-connection-service-runtime.test.ts` must prove:

- Snapshot subscription remains valid while Activity/WebView is detached.
- Reattach consumes the latest service snapshot without creating a reconnect intent.
- Foreground/background, pause/resume, visibility, and Activity recreation do not call connect, probe, route selection, heartbeat, or socket close.
- Foreground resume on an open channel sends `buffer-head-request` on the same socket and applies the missing body range without changing physical generation.
- Foreground resume with a missing socket or closed channel performs no UI-owned reopen/reconnect; service failure/backoff tests separately prove recovery remains live.
- If a legacy hook still delivers `notifyTargetNetworkSignal({ source: 'foreground-resume' })`, the transport runtime treats it as data-refresh-only: no target probe, no network-generation retire, no reconnect wake.
- The reducer has no `request-reconnect` output.

### Native tests

`AndroidConnectionServiceTest.java`, `AndroidConnectionServiceTransportTest.java`, and `AndroidConnectionServicePluginTest.java` must use fake clock/handler and fake socket seams to cover heartbeat survival across Activity detach, three-miss retirement, auth stop, backoff scheduling, stale generation rejection, manual route command validation, mux-hello retry before mux-ready, and atomic pending-frame consumption with FIFO continuation.

Exact channel-open admission:

- Rex open qualification happens in `TargetRuntime.sendChannelOpen` before
  reuse, desired-channel registration, replacement, queue migration, or wire
  send. The request must carry a nonblank string `expectedSessionIdentity` and
  literal boolean `existingOnly: true`. Missing or malformed identity uses the
  existing `command-rejected` result with
  `invalid-expected-session-identity`. A missing or nonliteral `existingOnly`
  also ends at `command-rejected` without a desired channel or
  `mux-channel-open`. There is no name-based fallback for Rex.
- A `mux-channel-open` that carries `expectedSessionIdentity` is qualified. Its
  `mux-channel-opened` acknowledgement must carry the same nonblank string
  `stableId`. Missing, non-string, blank, and unequal values fail with
  `session_identity_mismatch`. The native owner must not derive identity from
  the session name.
- Qualification is triggered by the explicit option, not by backend. Rex and
  another supported backend must use the same check.
- No opened state, opened event, input drain, or channel-message publication may
  happen before admission. An unqualified legacy open keeps its previous
  acknowledgement behavior.
- A qualified and an unqualified request are not equivalent. Qualified requests
  with the same session name and backend but different exact identities remain
  separate channels.
- Failure retires only the failed channel's desired intent, queues, and late
  sends. It sends one channel-local close frame when mux is ready and publishes
  one typed channel closure. It must not fail, reconnect, or rebuild the target.
- A sibling channel stays usable. Late opened, `connected`, body, and input-ACK
  frames on a retired channel do not reach its consumer.
- Cancellation and peer close retire local channel state before late traffic is
  processed. A later acknowledgement cannot recreate the channel. A close
  response to an already retired channel does not publish a second terminal
  closure.
- A scheduled callback from a retired lifecycle must not write or repark that
  channel's business frame. This is lifecycle fencing, not same-identity queue
  migration.

Required JVM cases:

- A Rex open with no identity, a non-string or blank identity, or without
  literal `existingOnly: true` publishes one typed command rejection. It sends
  no `mux-channel-open`, mutates no prior desired channel, and does not replace
  or reuse an existing channel.
- Valid Rex fixtures carry `existingOnly: true`; the initial and replay
  `mux-channel-open` payloads preserve that literal and the original exact
  identity.
- Matching exact acknowledgement releases only that channel's queued input.
- Missing and different exact acknowledgements do not release input and publish
  one typed closure.
- Non-string and blank requested identities are rejected rather than treated as
  legacy opens.
- A generic backend exact open passes; an unqualified legacy open accepts a
  legacy acknowledgement.
- A same-name, different-exact replacement does not reuse or drain the old
  channel. Same-name exact siblings remain isolated.
- A failed exact channel does not affect a healthy sibling; late opened,
  connected, body, and input-ACK traffic is suppressed.
- Local cancellation and peer close reject a later matching acknowledgement.
- A retired scheduled send neither writes nor repopulates the channel queue.

The existing same-session replacement queue-migration case remains a separate
defect. These admission tests must not depend on that migration passing.

Admitted identity projection:

- `open_session_channels` completes only after an admitted `mux-channel-opened`
  acknowledgement commits into the native channel snapshot. The exact daemon
  `stableId` string is stored once on the current
  `AndroidConnectionServiceSnapshot.Channel`. It is not copied from the
  requested identity, session name, backend, or WebView state.
- `project_service_snapshot` reads that same channel record for both the
  immediate opened event and a later snapshot-only reattachment. The opened
  event does not carry a second top-level identity source.
- `stableId` is optional. A legacy tmux or Herdr channel with no daemon
  identity remains open and projects without the field. When present, the
  exact admitted string survives snapshot serialization, immutable copies,
  and close-state copies.
- A heartbeat pong may move the native service to `HEALTHY`. A later admitted
  channel open must still commit into the snapshot and move the service to
  `CHANNELS_READY`. Transport and input owners remain unchanged.
- A valid opened result is scoped to the current target, generation, and exact
  channel ID. Closed, retired, old-generation, or unknown-channel events do
  not create an opened projection. Two same-name channels project their own
  identities and never substitute by session name.

Required projection cases:

- Public socket output carries `stableId` when the current native channel has
  it.
- Event-first and snapshot-first emit exactly one opened payload with the same
  identity.
- A fresh WebView that receives only the current snapshot replays one opened
  payload without bind, open, reconnect, close, or release commands. The
  reattachment test must first execute the real UI detach, then call
  `reattach()`, assert that it returns true, and assert that the current
  snapshot is read again.
- Legacy snapshots without identity still emit their opened payload without
  `stableId`.
- Closed, stale-generation, and mismatched-channel events emit no opened
  payload. A current sibling remains projectable.

Rex native input readiness:

- A matching exact `mux-channel-opened` commits `opened` and its `stableId`
  projection, but does not release Rex `input`. Only a `connected` message for
  that current opened channel on the current transport generation sets the
  internal input-ready fact. Every admitted Rex channel has a valid exact
  identity by the send-owner invariant, and its input waits for terminal
  `connected`. The missing-identity readiness bypass is not part of the Rex
  contract.
- Readiness is channel-local and internal. It is not copied to the public
  snapshot and is not derived from session name, target state, `mux-ready`,
  `buffer-head`, `buffer-sync`, `input-ack`, or the transport state machine.
- A pre-admission `connected` is discarded and not replayed after admission.
  Duplicate `connected` does not duplicate a consumed input.
- Replay or a new transport generation clears readiness before resending the
  exact open intent. Reopening with the same exact identity and current lifecycle
  does not clear a readiness already established on that current channel.
- Final input submission rechecks the current `ChannelIntent` and lifecycle.
  Immediate send, pending drain, retry, deferred recovery, flow resume, and
  successful-send FIFO continuation all use that same check.
- Held Rex input does not block attach control such as body subscription.
  Input order remains FIFO. A control frame may pass the held head while the
  input remains queued.
- A channel-local close, attach failure, cancellation, or identity failure
  discards that channel's held input and pending deferred callbacks. A sibling
  channel and the physical target remain usable.
- Legacy and non-Rex channels keep their existing open and ACK-time release
  behavior. Explicit exact identity admission still applies to any backend
  that requests it, while only Rex input waits for terminal `connected`.

Required readiness cases:

- Actual `WebSocketListener.onMessage` ingress for ACK, control progress,
  same-channel `connected`, and released input; no helper-only readiness call.
- Two same-name Rex channels with different exact identities remain isolated
  through ACK and `connected`.
- Attach failure and local cancellation discard held input; late `connected`
  cannot revive the retired channel.
- Replay clears readiness and preserves exact open options; existing exact
  channel reuse neither drains input nor resets current readiness. Initial and
  replay Rex frames both preserve `existingOnly: true`.
- Existing immediate, retry, deferred, flow-resume, and replay owners remain
  covered by the focused native transport suite.

The native WebRTC backend gate must additionally cover offer/answer, early ICE ordering, direct versus relay ICE policy, ordered reliable DataChannel text/binary frames, exact generation fencing, close/error cleanup, and the negative guarantee that the backend cannot schedule route retry or create mux/channel state itself. The candidate gate must also verify relay signal URLs carry the Relay access token as `signalToken` while non-relay signal URLs keep the daemon `authToken`, and that direct-path `rtc-answer` SDP is stripped of host and Tailscale ICE candidates before `setRemoteDescription`.

### Existing regression gates

Update the existing lifecycle/power tests to assert the new boundary:

- `android-power-policy.test.ts`: old `BackgroundService` JS wakeup is absent; native service owns the timer.
- `useOpenTabLifecycleEffects.test.tsx`: no network probe, fingerprint probe, background heartbeat, or reconnect behavior.
- `session-context-transport-orchestration-runtime.test.ts`: UI cannot trigger target network probing.
- `session-context-activity-runtime.test.ts`: `allowReconnectIfUnavailable` is removed from the UI contract.
- `session-context-transport-open-runtime.test.ts` and lifecycle tests: Activity lifecycle never reconnects.

## Positive and Negative Pairing

| Positive | Negative |
| --- | --- |
| Native service reaches `Healthy` | UI lifecycle cannot reach `Connecting` |
| Pong preserves the generation | Three misses retire exactly that generation |
| Manual route command changes policy | Snapshot/event cannot change policy |
| Detached UI receives later snapshot | Detached UI cannot trigger reconnect |
| Foreground data refresh requests head on the existing channel | Missing/closed projection cannot reopen a channel or transport |
| Current generation accepts a server frame | Stale generation is rejected |

## Black-box Acceptance

On an online ADB device, keep the service target bound, detach/recreate WebView, toggle network availability, and reattach the UI. The service must reconnect without an Activity callback or JS timer, and the first UI snapshot after reattach must identify the current generation. No claim of completion is valid without this online evidence when the device is available.
