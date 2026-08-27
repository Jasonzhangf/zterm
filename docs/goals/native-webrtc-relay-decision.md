# Native WebRTC Relay Ownership Decision

Date: 2026-08-27
Status: accepted design; implementation pending
Feature: `android.transport.native_webrtc`

## Decision

Choose scheme B: keep `AndroidConnectionService` as the sole owner of the
Android daemon-target physical transport lifecycle, and add native WebRTC as a
candidate-specific `TransportBackend` beneath that owner.

The backend may use libwebrtc, `wrtc-android`, or another verified Android
WebRTC binding. The library is an engine, not a new owner. It must not own route
selection, target generation, mux/channel state, heartbeat, reconnect/backoff,
or UI/session truth.

Do not change `RTC_DIRECT` or `RTC_RELAY` from the current explicit
`webrtc-not-supported` result until the dependency preflight, machine maps,
paired tests, Android build, and installed-device gates below all pass.

## Current Evidence

- `AndroidConnectionService.startAttempt()` explicitly rejects manual
  `RTC_DIRECT` and `RTC_RELAY` with `webrtc-not-supported`.
- `AndroidConnectionService.buildCandidates()` currently produces only
  Tailscale, IPv6, and IPv4 WebSocket candidates.
- `android/native/android/app/build.gradle` has no WebRTC dependency, so the
  native service has no peer connection, ICE, or data-channel implementation.
- WebView `TraversalSocket` already implements signaling, ICE direct/relay,
  ordered data channels, route diagnostics, and restart handling, but Android
  native session transport is forced through
  `openAndroidConnectionServiceTransportSocket()`.
- `resource.android_connection_service` is active and owns physical transport,
  mux, heartbeat, network generation, reconnect/backoff, and route policy. Its
  forbidden relations include open tabs, active session, UI, buffer, renderer,
  tmux session, and mirror store.
- `client.android_connection_service` is the active module owner. The function
  map already says native WebRTC/Relay media is a separate explicit slice; it
  does not authorize a second lifecycle owner.

## Architecture Mapping

Change class: separate/downward implementation slice. This is not a new
session, transport-lifecycle, or signaling owner.

Unique owner:

- Feature owner: `client.android_connection_service`
- Resource owner: `resource.android_connection_service`
- Runtime owner: `AndroidConnectionService`
- Backend responsibility: one candidate's signal/peer/ICE/data-channel I/O

Allowed path:

```text
route policy
  -> shared traversal candidate adapter
  -> native WebRTC TransportBackend
  -> typed physical transport events
  -> AndroidConnectionService target generation and mux/channel lifecycle
  -> existing SessionContext projection
```

The candidate adapter may consume typed `signalUrl`, `relayHostId`,
`iceServers`, `iceTransportPolicy`, and route-diagnostic facts. It may not
recompute the global candidate order or own credentials.

Forbidden paths:

- No separate native service, signaling daemon, target lifecycle, mux/channel
  registry, heartbeat, reconnect loop, or route-health owner.
- No direct backend access to UI, SessionContext, open tabs, active session,
  foreground/background, viewport, terminal mirror, sparse buffer, or renderer.
- No second `relayHostId`, TURN credential, or traversal-plan truth.
- No peer or data-channel reuse across target generations.
- No retry, health, provider, debug, or control facts inside SDP, data-channel
  business payloads, terminal payloads, or generic metadata.
- No WebSocket, screenshot, or other fallback that projects a failed WebRTC
  candidate as successful.

## Options

### A. Independent native WebRTC and signaling slice

Owner model: a new native WebRTC/signaling owner creates signaling, peer, ICE,
data-channel, relay, and cleanup lifecycles; `AndroidConnectionService` calls
into it.

Integration cost:

- Highest. It requires a second lifecycle surface, new resource/module/edge
  maps, native signaling and route-parity logic, and additional cleanup and
  generation coordination.
- It risks duplicating traversal planning, route health, relay identity,
  reconnect, and credential truth already owned elsewhere.
- ABI, NDK, minSdk, packaging, ProGuard, and APK-size work is unchanged from B,
  while owner and verification cost is materially larger.

Rollback/removal:

- Delete the independent slice and restore the current explicit unsupported
  result.
- This is physically removable, but its duplicate ownership makes safe removal
  and parity verification more expensive.

Decision: rejected. It creates a second owner without a current requirement
that scheme B cannot satisfy.

### B. AndroidConnectionService-owned WebRTC backend

Owner model: `AndroidConnectionService` keeps target generation, candidate
selection, mux/channel, heartbeat, retry/backoff, route-health reporting, and
cleanup. A typed backend implements only the selected WebRTC candidate.

Integration cost:

- Medium. It adds one native engine and adapter contract without replacing the
  installed service lifecycle or WebView projection boundary.
- Shared traversal candidate semantics can be mapped once into native types;
  the backend does not make route decisions.
- Failure and close return through existing typed service events and exact
  target-generation fences.

Rollback/removal:

- Remove the backend and its candidate adapter from the service owner.
- Restore the current `webrtc-not-supported` result for RTC candidates.
- Keep WebSocket candidates and the rest of the service lifecycle unchanged.
- A backend failure is an explicit candidate failure. Existing candidate
  selection may continue according to registered route policy, but the backend
  itself must not silently switch transports.

Decision: accepted. It reaches native Android WebRTC/Relay without creating a
second transport-lifecycle truth.

## Implementation Gates

### 1. Machine-map gate

Before runtime code:

- Extend `resource.android_connection_service` allowed operations and direct
  relations for the typed candidate backend.
- Add backend owned paths to `client.connection_service`; do not register a
  second session/transport owner.
- Register only adjacent resource/import/call edges.
- Update function map, mainline call map, verification map, and test design.
- Keep all entries `design` until their code and gates exist; only then move
  them to `active`.

Required architecture gates:

- `test:feature-registry`
- resource, module, edge, function, mainline-call, and import graph truth tests
- control/payload isolation and forbidden-relation negative tests

### 2. Dependency preflight

Prove before wiring production code:

- fixed artifact/version and reproducible repository resolution
- supported ABIs, minSdk/targetSdk, Java/Kotlin/NDK requirements
- ProGuard/R8 and packaging behavior
- peer connection, early ICE, relay-only policy, ordered text/binary data
  channels, close/dispose, and required stats APIs
- APK-size impact and license/security review

If preflight fails, retain explicit unsupported behavior. Do not leave a
half-wired dependency or alternate runtime path.

### 3. Paired red tests

Positive cases:

- Direct and TURN relay candidates establish one ordered data channel.
- Text and binary mux frames preserve bytes and order.
- Current target generation reaches mux-ready and target heartbeat health.
- Network generation change closes the old peer and rebuilds through the
  existing service owner.

Negative cases:

- Relay-only policy never accepts a direct candidate.
- Candidate-before-offer and duplicate signaling do not corrupt peer state.
- Old-generation ICE, data-channel messages, close, and errors are rejected.
- Failed/non-terminal/already-terminal close paths dispose each peer, channel,
  signaling socket, timer, and listener exactly once.
- Backend failure cannot create a second reconnect loop, mux registry, route
  decision, or successful projection.

### 4. Build and integration gates

- `test:android-connection-service`
- `test:transport-network-lifecycle`
- traversal, route-health, mux, and protocol parity tests
- `type-check`
- Android unit tests and debug/release compile
- full Android build with dependency and APK manifest inspection

### 5. Installed-device gates

With an online ADB device and the built APK installed:

- direct WebRTC and TURN relay establish the same daemon target/mux contract
- text and binary terminal traffic pass end to end
- Wi-Fi/cellular or network-generation change recovers through one owner
- stale generation traffic is rejected
- close, failure, background/foreground, and target release leave zero peers,
  channels, signaling sockets, timers, and listeners
- installed version and runtime hashes match the reviewed source commit

Only after these pass may AGY Review run. Any later code, dependency, build, or
runtime-configuration change invalidates the prior build, device, and review
evidence.

## Non-goals

- No runtime, dependency, protocol, registry, or UI change in this decision
  task.
- No claim that native RTC is available today.
- No redesign of WebView `TraversalSocket`, daemon RTC bridge, terminal mux,
  Relay account directory, buffer, renderer, or remote-window media.
