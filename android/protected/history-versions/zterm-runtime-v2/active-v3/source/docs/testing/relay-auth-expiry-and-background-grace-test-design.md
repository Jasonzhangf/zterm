# Relay Auth Expiry And Background Grace Test Design

## Owners

- `relay.account_directory`: `traversal-relay-client.ts` classifies authoritative Relay authentication rejection; `relay-device-stream-runtime.ts` terminates the invalid control identity; `useRelayDeviceStream.ts` clears persisted account, Relay settings, device projection, and confirmed directory truth.
- `terminal.transport_lifecycle`: `useOpenTabLifecycleEffects.ts` owns the five-minute background grace before projecting the client inactive, the retained-session count lifecycle for the native service, and the separation between service lifetime and background heartbeat callback. `session-context-socket-runtime.ts` owns the daemon-target physical heartbeat at `30_000ms`. Native `BackgroundService` remains process-execution support and never owns WebSocket/session truth.
- `relay.account_directory`: `relay-device-stream-runtime.ts` owns the Relay device control stream heartbeat at `30_000ms`; `traversal-relay-client.ts` and `traversal-relay/server.ts` carry only typed `control-ping/control-pong` control envelopes.

## Lifecycle Cases

1. Authenticated refresh succeeds: preserve account/settings and open one device control stream.
2. `/api/auth/me` returns 401 or 403: emit typed auth rejection, clear the exact local account and Relay settings, publish disabled directory truth, and do not reconnect with the rejected token.
3. Device stream closes with code 4001: perform the same invalidation once and do not schedule reconnect.
4. Transient HTTP/network failure or ordinary stream close: preserve account and confirmed directory cache, then reconnect control only.
5. App enters background: mark hidden immediately, enable only the background heartbeat callback, and keep the retained-session service and client transport lifecycle active for 300 seconds.
6. App resumes within 300 seconds: disable only the background heartbeat callback, keep the retained-session service and physical transport, and run the normal foreground audit.
7. App remains backgrounded beyond 300 seconds: project inactive once; a later resume projects active once and runs normal recovery while the retained-session service remains alive.
8. The final retained session closes in either UI state: stop the native service and clear the background heartbeat callback.
9. Terminal daemon-target transport stays open while idle: send target-level mux heartbeat every 30 seconds; matching mux pong or validated target activity keeps the physical transport alive.
10. Terminal daemon-target heartbeat misses the configured consecutive threshold: close that exact physical transport once and let the target failure/reconnect owner rebuild it.
11. Relay device control stream stays open while idle: send typed `control-ping` every 30 seconds; `control-pong` keeps the control stream alive without terminal/session payload.
12. Relay device control heartbeat misses the configured consecutive threshold: close only the Relay device stream and reconnect that control stream; terminal business channels are not used as heartbeat proof.

## Positive And Negative Gates

- Positive: valid token, transient network failure, sub-five-minute resume, over-five-minute resume, terminal mux heartbeat pong, and Relay control pong.
- Negative: invalid token never remains visually logged in, never loops reconnect, and never retains stale Relay settings/directory; duplicate hidden signals never extend the original grace deadline; cleanup cancels the timer; control heartbeat timeout closes only the owning physical control socket and does not write terminal payload or UI fallback state.

## Required Verification

- `src/lib/traversal-relay-client.test.ts`
- `src/lib/relay-device-stream-runtime.test.ts`
- `src/traversal-relay/server.test.ts`
- `src/hooks/useOpenTabLifecycleEffects.test.tsx`
- Relay account/directory and terminal transport mapped gates
- Type-check, Android build, global daemon install/restart, installed-phone sub-five-minute background/foreground proof, then review

## Known Boundary

The five-minute grace keeps the existing JavaScript transport lifecycle active while Android permits WebView execution. It does not prove indefinite execution under Doze/vendor battery policy. Persistent background is a separate explicit product mode and requires its own native/control-plane design and real long-duration device gate.
