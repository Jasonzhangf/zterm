# zterm connection / route / download fast-path remediation goal

## Objective

Make zterm choose fast direct paths before slow fallbacks, prove large downloads use raw binary streaming on LAN/Tailscale, and leave WebRTC/Relay as explicitly degraded fallback only. This goal is complete only when design, code fix, tests, installed-app replay, runtime evidence, and cleanup are all evidenced.

## Current baseline to preserve

- Worktree: `/Volumes/extension/code/zterm/playground/route-download-fastpath-0928/android`
- Branch: `codex/route-download-fastpath-0928`
- Existing candidate already has:
  - TS auto WebSocket priority `lan -> tailscale -> ipv6 -> ipv4`.
  - TS/native auto plans skip WebRTC critical-path candidates.
  - Native Android candidate order LAN -> Tailscale -> IPv6 -> IPv4, with `rtc-relay` only when no direct candidates exist.
  - Route diagnostics projected for native candidate attempts.
  - Daemon `GET /api/v1/files/download?path=<remotePath>` raw HTTP binary endpoint with auth and `Content-Length`.
  - Client binary download runner for `resolvedPath=lan|tailscale`; Relay/WebRTC keep terminal-mux chunk fallback.
- Do not regress existing file-transfer persistence, chunk fallback, daemon auth, or terminal mux invariants.

## Required route policy

1. Default auto route priority must be:
   - `lan` first
   - `tailscale` second
   - `ipv6` third
   - `ipv4` fourth
   - `rtc-relay` only as final degraded fallback when no direct WebSocket candidates exist
2. WebRTC is not part of the default auto critical path. Because WebRTC is currently basically unusable for zterm, any RTC/WebRTC path must be manual/experimental/degraded only, never selected to satisfy the mainline connection goal.
3. Direct candidates must win before Relay when they are actually usable. Do not commit Relay while a higher-priority direct candidate may still land.
4. Health/RTT may order candidates only within the same tier. Health may not promote Relay over healthy LAN/Tailscale/IPv6/IPv4 direct paths.
5. A route is healthy only after authenticated WebSocket/RPC handshake and mux readiness. IP reachability or HTTP health alone is not terminal readiness.
6. UI/debug labels must distinguish `lan`, `tailscale`, `direct`, and `relay-degraded`; Relay must not be presented as the fast path.

## Required LAN host-truth fix

Current gap: `src/lib/android-connection-service-factory.ts` only sets `lanHost` from Relay directory candidates with `kind=lan`. When a saved/local target has `bridgeHost` that is already LAN/loopback, such as `127.0.0.1` on the emulator-to-host path or a private LAN IP, the native target may omit `lanHost` and incorrectly start with Tailscale.

Fix contract:
- Populate `lanHost` from the authoritative LAN candidate source first.
- If no directory LAN candidate exists, use `bridgeHost` when `parseEndpointHost(bridgeHost)` is a private LAN IPv4 host according to `isPrivateLanIpv4Host`.
- If a directory LAN candidate exists, keep it authoritative; do not overwrite it with `bridgeHost`.
- Native `isLocalLanHost` should accept loopback as LAN when the configured LAN host is the host's own loopback and the Android device can route there, otherwise LAN-first proof will not be possible in emulator host replay.
- Preserve the existing guard that public non-LAN `lanHost` values are not admitted by native same-subnet probing.

## RustDesk reference to apply

Use RustDesk as behavior reference, not as a reason to make WebRTC the critical path:
- Race/probe direct paths and relay, but keep relay yield/degrade behind direct-path preference.
- Prefer direct/P2P as soon as it is truly usable; do not let a fast relay win become the committed default when direct is still available.
- Treat relay success as degraded continuity, not a performance proof.

Applied zterm policy:
- LAN/Tailscale direct WebSocket is the default fast tier.
- Public direct IPv6/IPv4 is next.
- rtc-direct is manual/experimental unless explicitly selected.
- rtc-relay is final degraded fallback only.

## Required download policy

1. For `resolvedPath=lan|tailscale`, large file download must use daemon HTTP binary streaming:
   - `GET /api/v1/files/download?path=<remotePath>`
   - raw `application/octet-stream`
   - `Content-Length`
   - daemon auth required when daemon requires auth
   - client validates received byte count against expected total before completion
   - client persists through existing `FileTransferDownloadStore`; no Node-only `fs`/`Buffer` dependency in the browser runner.
2. Relay/WebRTC paths may retain terminal-mux `file-download-chunk` fallback, but they must not be the default speed-validation path and must not be labeled as fast.
3. Download diagnostics/evidence must include enough to prove the real path used: `resolvedPath`, daemon host/port, bytes, firstByteMs, totalMs, MB/s, sha256, and source sink path.

## Test matrix

Must add/update tests for:
- TS route priority:
  - auto plan orders `lan -> tailscale -> ipv6 -> ipv4`
  - WebRTC candidates are absent from auto critical-path plan
  - relay only enters when no direct candidates exist
- TS/native routing:
  - tier order is authoritative; health/RTT cannot promote relay over direct
  - failed LAN falls through to Tailscale, not WebRTC/Relay
  - route diagnostics include candidateId/path/endpoint/reason/startedAt/endedAt/elapsedMs/selected/failureCode where implemented
- Android connection target construction:
  - directory LAN candidate remains authoritative
  - no directory LAN candidate + private LAN `bridgeHost` produces `lanHost`
  - no directory LAN candidate + loopback `bridgeHost` produces `lanHost`
  - no directory LAN candidate + public `bridgeHost` does not produce `lanHost`
- Native Android candidate builder:
  - same-subnet LAN comes before Tailscale/IPv6/IPv4
  - loopback/private LAN target starts before Tailscale
  - auto candidates do not contain `rtc-direct` or `rtc-relay`
  - explicit manual RTC remains available and remains degraded/manual only
- Binary download:
  - selected only for `lan`/`tailscale`
  - rejects relay/rtc paths
  - validates auth, content type, Content-Length, size mismatch, cancellation/error surface
  - persists to existing download store and reports exact bytes
- Existing regression suites:
  - traversal tests
  - file transfer runtime/sheet/throughput tests
  - Android connection service native gate
  - type check

## Build/install/runtime acceptance

Before claiming completion:
1. Rebuild APK with the repository's normal Android debug build path.
2. Install the rebuilt APK to the target emulator/device and capture version/buildNumber/APK sha256.
3. Restart daemon if any daemon/server behavior changed.
4. Replay a connection from the installed app UI.
5. Capture logcat/UI evidence proving:
   - bind target included `lanHost` for LAN/loopback bridge targets where applicable
   - native log starts `opening lan ...` before Tailscale when LAN is eligible
   - snapshot/route diagnostics show selected path `lan` or `tailscale`, not `rtc-relay`
   - no default WebRTC path is used
6. Replay LAN and Tailscale 50MB downloads through the installed app when the file-browser UI supports it, or through a real installed-app-originated HTTP path when UI automation is unreliable.
7. Record host-side probes under `evidence/route-download-fastpath-0928/`:
   - loopback/LAN/Tailscale HTTP binary download
   - sha256 comparison against source file
   - firstByteMs, totalMs, MB/s, bytes
   - explicit note if host-side 10.0.2.2 or app-level replay remains unavailable
8. Cleanup only this run's temporary artifacts after preserving evidence. Do not delete shared evidence, other worktrees, other processes, or installed apps unless explicitly authorized.

## Acceptance status definition

- `DONE`: all code changes, unit/native gates, type-check, APK install, real route replay, and applicable 50MB app-originated download evidence are present.
- `UNVERIFIED`: app-level evidence cannot be captured; host-side HTTP evidence exists but does not prove installed-app path.
- `INCOMPLETE`: required code/test/build/runtime node is missing.

Required final report fields:
- candidate SHA / worktree / branch
- files changed and owner rationale
- test commands and results
- APK version/buildNumber/sha256
- route replay evidence path
- download evidence path and sha256/speed numbers
- cleanup status
- remaining blockers, if any

## Non-goals

- Do not make WebRTC the critical path as part of this remediation.
- Do not optimize Relay/WebRTC chunk fallback throughput as the success criterion.
- Do not use Terminal base64 JSON chunks as LAN/Tailscale large-download proof.
- Do not claim app-level download replay unless the evidence was captured from the installed app or a real installed-app-originated network path.
