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

## 4. Evidence

- APK: update-dist/zterm-0.1.3.3167.apk, versionCode 1100031670
- Emulator replay: 50MB file downloaded to files/zterm-verification
- Device SHA256: 8565a714dca840f8652c5bae9249ab05f5fb5a4f9f13fbe23304b10f68252da2
- Route diagnostics: AndroidConnectionService diagnostics and traversal tests
- Review status: architecture review FAIL (owner boundaries not accepted yet)

## 5. Remaining

- Address review owner-boundary blockers before merge/push.
- Produce LAN/Tailscale MB/s and relay degraded diagnostics in final report.
- Cleanup verification after delivery.
