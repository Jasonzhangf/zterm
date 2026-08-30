# Connection Service Owner Migration Test Design

Date: 2026-08-18
Feature: `client.android_connection_service`
Owner module: `client.connection_service` (status: `active`; native WebSocket ownership is installed, native WebRTC/Relay media remains a separate pending slice)

## Scope

The migration must make `AndroidConnectionService` the sole owner of the physical WebSocket, route/auth, mux/channel, heartbeat, network-generation, reconnect/backoff, and connection-generation truth. Activity, WebView, and React may only consume snapshots/events and send explicit typed commands.

WebRTC native ownership is out of scope. A WebRTC-only route must fail explicitly until a separate slice lands.

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
- The reducer has no `request-reconnect` output.

### Native tests

`AndroidConnectionServiceTest.java`, `AndroidConnectionServiceTransportTest.java`, and `AndroidConnectionServicePluginTest.java` must use fake clock/handler and fake socket seams to cover heartbeat survival across Activity detach, three-miss retirement, auth stop, backoff scheduling, stale generation rejection, manual route command validation, mux-hello retry before mux-ready, and atomic pending-frame consumption with FIFO continuation.

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
