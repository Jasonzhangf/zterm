# Route & Download Fast-Path Remediation DAG

Date: 2026-09-29
Status: candidate (review not yet PASS; E2E replay passed)
Worktree: /Volumes/Intel/playground/zterm/route-download-fastpath-0928

## 1. Goal

Make LAN/Tailscale/direct the real default connection path, keep Relay as an
explicit degraded fallback, keep WebRTC out of the default critical path, and
route large file downloads over HTTP binary streaming on LAN/Tailscale instead
of terminal mux base64 chunks.

## 2. Route DAG (single entry -> single exit)

- app route intent
- candidate discovery (TS traversal/config.ts + route-selector.ts; Native AndroidConnectionService.java)
- eligibility (same-subnet LAN, Tailscale 100.x, public IPv6/IPv4, experimental rtc-direct manual only, relay fallback)
- parallel bounded probing (pending[] -> running[] -> selected | failed[])
- authenticated mux handshake (auth + mux-hello + mux-ready)
- route commit (first authenticated mux-ready commits; losers cancelled and resources freed)
- diagnostics (candidateId, path, endpoint, reason, startedAt, endedAt, elapsedMs, selected, failureCode)
- failure/fallback (Relay only after direct tier exhausted; UI marks degraded)
- cleanup (sockets/timers cancelled, committedCandidate invariant)
- retry/resume (bounded backoff, no silent fallback)

Default priority: LAN -> Tailscale -> IPv6 -> IPv4 -> rtc-relay -> rtc-direct

## 3. File Download DAG

- LAN/Tailscale: daemon HTTP binary streaming with auth, Content-Length/progress/abort/resume as available; verify size + sha256; save to app-private verification dir (E2E harness only)
- Relay/degraded: file-download-chunk fallback with shared constants, frame budget, bounded window/ack; UI explicitly degraded; no silent fallback from HTTP failure unless explicit policy

## 4. RustDesk Alignment

RustDesk's public positioning treats rendezvous/relay as connection setup
infrastructure while preferring direct remote connections through TCP hole
punching when possible, with relay as the fallback path. It also exposes
advanced controls for Direct IP and Virtual Network routing. The applicable
principle for zterm is: direct local paths win before generic relay, relay is
setup/fallback infrastructure only, and large transfers avoid base64 chunk
encapsulation when a direct HTTP binary path exists.

## 5. Current vs Ideal Gap

| Area | Current before remediation | Ideal / target DAG | Delivery owner |
| --- | --- | --- | --- |
| Route priority | Mixed WebRTC/relay ordering allowed fast degraded paths to win before LAN/Tailscale could prove authenticated readiness. | Parallel bounded race starts from LAN, then Tailscale/IPv6/IPv4; Relay/RTC open only after direct tier exhaustion; single `mux-ready` commits selected path. | `lib/traversal/config.ts`, `lib/traversal/route-selector.ts`, native `AndroidConnectionService.java` |
| Download path | Large downloads could traverse terminal mux chunk/base64 even when LAN/Tailscale HTTP is available. | LAN/Tailscale selected route uses `/api/v1/files/download` HTTP binary streaming; chunk download only remains degraded fallback for relay/rtc/no-fast-path. | `file-transfer-session-runtime.ts`, `file-transfer-binary-download-runtime.ts`, `file-transfer-native-store-port.ts` |
| Verification entry | App deep-link handler could choose recent/fallback hosts and build targets, mixing app shell ownership with verification/session-open decisions. | App only parses URL and posts a typed verification open request; session-open owner resolves host/target, opens session, and dispatches verification download. | `App.tsx`, `hooks/useZtermVerificationIntent.ts`, `lib/zterm-verification-queue.ts` |
| Verification queue | Peeking plus later take made ownership unclear. | One-shot claim only: `claimZtermVerificationDownload()` consumes the target exactly once. | `lib/zterm-verification-queue.ts` |
| Verification storage | Product file transfer helpers recognized the verification-only directory. | Verification path remains E2E fixture only, isolated from normal product download runtime. | `components/terminal/FileTransferSheet.tsx`, `lib/file-transfer-native-store-port.ts` |

## 6. Delivery Plan

1. Author this DAG/current-vs-ideal design and keep route/download owners explicit.
2. Make verification deep-link handling one-shot and move host/session decisions out of the App shell.
3. Remove verification-only path recognition from normal product download helpers.
4. Add/adjust tests for queue claim, verification intent ownership, route priority, LAN binary fast path, relay fallback, abort and size mismatch.
5. Run targeted tests and type check.
6. Build Android APK from the same candidate, install it on emulator/device, replay 50MB download, and capture route, SHA, MB/s and degraded/relay diagnostics.
7. Submit the candidate to independent architecture review; merge/push only after PASS.
8. Clean this task's worktree, playground evidence-only resources, temp files, forwards, and processes after merge evidence is captured.

## 8. Evidence

- Previous replay APK: update-dist/zterm-0.1.3.3167.apk, versionCode 1100031670
- Emulator replay: 50MB file downloaded to files/zterm-verification
- Device SHA256: 8565a714dca840f8652c5bae9249ab05f5fb5a4f9f13fbe23304b10f68252da2
- Route diagnostics: AndroidConnectionService diagnostics and traversal tests
- Review status: architecture review FAIL (owner boundaries not accepted yet)

## 9. Remaining

- Address review owner-boundary blockers before merge/push.
- Produce LAN/Tailscale MB/s and relay degraded diagnostics in final report.
- Cleanup verification after delivery.
