# Android Connection Service Owner Migration Plan

Date: 2026-08-18
Feature: `terminal.transport_lifecycle`

## 1. Objective

Move the Android client physical connection truth from WebView/React into a native Android foreground service.

Target ownership:

```text
AndroidConnectionService
  = physical transport owner
  = route/auth owner
  = mux/channel lifecycle owner
  = heartbeat/liveness owner
  = network-change validation owner
  = reconnect/backoff owner
  = connection-generation owner
  = desired route policy owner

Activity/WebView/React UI
  = service snapshot/event projection
  = attach/detach UI surface
  = explicit typed command sender
```

The only UI event that may change connection behavior is a user-selected manual route policy:

```text
User chooses a route
  -> SetManualRoutePolicy(route)
  -> AndroidConnectionService validates, reconnects, retries, publishes state
```

Foreground/background, pause/resume, visibility change, app state change, Activity create/destroy, and WebView recreate are projection events only. They must not create, close, replace, probe, or resume transport.

## 2. Current Root Cause

The current implementation is still:

```text
BackgroundService
  -> evaluateJavascript()
  -> window.ztermBackgroundHeartbeatTick
  -> JS callback
  -> SessionContext WebSocket/heartbeat/reconnect
```

The first divergence is `BackgroundService.java` + `BackgroundServicePlugin.ts` treating the WebView as the transport keepalive owner. Android timers wake JS, and JS owns socket, route, heartbeat, network validation, generation, and reconnect. This fails Jason's requirement because:

- Background return depends on WebView renderer survival.
- Activity/WebView recreation can break a physical transport that should stay owned by the process.
- Foreground resume still drives network resampling, target probe, and reconnect-adjacent decisions.
- `allowReconnectIfUnavailable` remains a UI/lifecycle parameter.

## 3. Target Architecture

### 3.1 Process Boundary

```text
AndroidConnectionService
  |
  +-- RoutePolicy
  |     desired route is service-owned; UI sends SetManualRoutePolicy only
  |
  +-- Native WebSocket transport
  |     one physical mux WebSocket per stable daemon target
  |
  +-- Native MuxLifecycle
  |     mux-hello/mux-ready, mux-ping/pong, target messages, channel open/close
  |
  +-- Native Heartbeat
  |     timer-owned 30s ping + consecutive miss policy
  |
  +-- Native Reconnect
  |     timer/delta-owned backoff; no WebView callback or UI lifecycle
  |
  +-- Native NetworkObserver
  |     validates generation/fingerprint without UI visibility state
  |
  +-- Typed IPC bridge
        commands: SetManualRoutePolicy, BindTargetRequest
        snapshots: ServiceSnapshot
        events: ServiceEvent

React/SessionContext
  |
  +-- Projection context
  |     reads snapshot only
  |
  +-- Terminal channel adapter
  |     consumes service events and wraps typed wire frames for React consumers
  |
  +-- UI command sender
        user route choice -> SetManualRoutePolicy
```

### 3.2 State Machine

```text
Idle
  -> ResolvingTarget       (target/policy received)
  -> Connecting            (native WS opening)
  -> MuxReady              (mux-ready received)
  -> ChannelsReady         (at least one channel opened)
  -> Healthy               (heartbeat/pong healthy)

Connecting/MuxReady/ChannelsReady/Healthy
  -> AuthenticationError   (401/auth failure)
  -> TerminalError/Unavailable
  -> BackoffReconnect      (physical close/missed heartbeats)

BackoffReconnect
  -> ResolvingTarget       (next attempt, same desired policy)
  -> TerminalError/Unavailable
  -> Idle                 (no retained target/policy)
```

States are service truth. UI projects the same states through `ServiceSnapshot`.

### 3.3 Command/Snapshot/Event Contract

Commands are typed control-plane values, never terminal business payload or metadata:

```ts
type AndroidConnectionCommand =
  | { type: 'set-manual-route-policy'; route: ServiceRoutePolicy }
  | { type: 'bind-target'; target: ServiceTarget }
  | { type: 'release-target'; reason: string };
```

Snapshots are projection resources:

```ts
interface AndroidConnectionServiceSnapshot {
  state: ServiceState;
  generation: string;
  target: ServiceTarget | null;
  route: ServiceRouteState | null;
  channels: Array<{ channelId: string; state: 'opening' | 'open' | 'closing' | 'closed' }>;
  lastHeartbeatAt: number | null;
  lastActivityAt: number | null;
  nextRetryAt: number | null;
  error: ServiceError | null;
}
```

Events are append-only:

```ts
type AndroidConnectionServiceEvent =
  | { type: 'state-changed'; snapshot: AndroidConnectionServiceSnapshot }
  | { type: 'server-frame'; frame: TerminalMuxServerFrame }
  | { type: 'command-rejected'; command: AndroidConnectionCommand; error: ServiceError }
  | { type: 'physical-error'; error: ServiceError };
```

Control-plane fields must not be written into `mux-channel-message`, `buffer-sync`, input, file, schedule, remote-window, or debug payloads.

### 3.4 Heartbeat and Reconnect Rules

- Heartbeat lives in the service thread: one timer per physical target.
- `mux-ping` is sent only by the service.
- Pong/any valid target frame resets the consecutive miss counter.
- Three consecutive misses finalize a physical generation and schedule one reconnect through native backoff.
- UI foreground/background never starts or stops heartbeat.
- A UI attach/detach changes only snapshot subscription, not service state.
- Stale generation events are rejected by generation check inside the service.
- Auth failures stop automatic reconnect and publish `AuthenticationError`.

## 4. Accepted Scope

This slice moves physical WebSocket, route selection for WebSocket candidates, auth query building, mux handshake, heartbeat, generation, and reconnect/backoff into the native service.

The native service owns direct/Tailscale/IPv4/IPv6 WebSocket candidates and explicit `SetManualRoutePolicy`. WebRTC is currently implemented in WebView with `RTCPeerConnection`; native WebRTC ownership is a separate slice. While WebRTC remains in WebView, the service must either expose an explicit error for WebRTC-only targets or delegate only media/signaling in a later controlled slice. It cannot claim full WebRTC ownership in this slice.

## 5. Governance and Docs

Before runtime edits, update in this order:

1. `android/docs/resource-registry.json`
2. `android/docs/module-registry.json`
3. `android/docs/edge-registry.json`
4. `android/docs/feature-registry.json`
5. `android/.appsdk/maps/resource-map.json`
6. `android/.appsdk/maps/module-registry.json`
7. `android/.appsdk/maps/function-map.json`
8. `android/.appsdk/maps/verification-map.json`
9. `android/docs/function-map.md`
10. `android/docs/wiki/mainline-call-map.json`
11. `android/docs/wiki/mainline-source.md`
12. `android/docs/testing/connection-service-owner-test-design.md`
13. `.agents/skills/zterm-mobile-dev/SKILL.md` where required

## 6. Red Gates

New/updated tests must prove:

- Activity foreground/background does not reconnect, probe, or switch route.
- WebView/React owns no heartbeat or reconnect timer.
- `BackgroundService.java` does not call `evaluateJavascript()`.
- `useOpenTabLifecycleEffects.ts` does not send `notifyTargetNetworkSignal`, background heartbeat callback, or fingerprint-triggered probe.
- UI lifecycle cannot pass `allowReconnectIfUnavailable`.
- UI can only send `SetManualRoutePolicy`/bind/release commands.
- Service snapshot changes while Activity/WebView is detached.
- Service auto-reconnect is timer/delta-owned, not WebView-callback-owned.
- Stale generation cannot pollute current generation.
- Command/error/control never enters terminal business payload or metadata.
- Positive and negative heartbeat/reconnect state machine tests.

Existing tests to update:

- `android/src/lib/android-power-policy.test.ts`
- `android/src/hooks/useOpenTabLifecycleEffects.test.tsx`
- `android/src/contexts/session-context-transport-orchestration-runtime.test.ts`
- `android/src/contexts/session-context-activity-runtime.test.ts`
- `android/src/contexts/session-context-transport-open-runtime.test.ts`
- `android/src/App.dynamic-refresh.test.tsx`

New tests:

- `android/src/lib/android-connection-service-snapshot.test.ts`
- `android/src/plugins/AndroidConnectionServicePlugin.test.ts`
- `android/src/contexts/android-connection-service-runtime.test.ts`
- Native unit tests under `android/native/android/app/src/test/java/com/zterm/android/`

## 7. Verification

Required before claiming completion:

1. Focused red tests fail on current code.
2. Implement service owner.
3. Focused tests pass.
4. `pnpm --dir android run test:feature-registry`
5. `pnpm --dir android run type-check`
6. `pnpm --dir android run build`
7. Build Android APK.
8. Install/real-device online verification when an online ADB device is available.
9. DSH Review through the `dsh` skill.

## 8. Non-Goals

- No changes to terminal buffer/render truth.
- No changes to daemon physical transport/mirror ownership.
- No WebRTC native ownership in this slice.
- No OTA publish, promotion, freeze, or main-tree merge without explicit authorization.
- No battery-optimization bypass.
