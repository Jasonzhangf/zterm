# Transport Resilience Plan

## Goal

Make the Android transport layer self-healing for transient failures.
File/screenshot uploads survive brief disconnections via per-chunk ACK +
resume. Users never see intermediate retry errors that auto-recover.

## Current State (audited 2026-08-22)

- `AndroidConnectionService.sendOrQueue`: send fail = immediate teardown of
  entire physical connection + backoff reconnect. No in-place retry.
- File upload: 16 KB base64 chunks over JSON mux frames. Sliding window of 8
  chunks. No per-chunk retransmit. No resume from last acked chunk after
  reconnect. `waitForProgress` times out at 15 s and surfaces error to UI.
- Screenshot: same chunked path, same lack of retry/resume.
- Error projection: every `transportFailure` immediately publishes
  `PHYSICAL_ERROR` → Capacitor → JS `androidConnectionError`. User sees
  errors that the service recovers from within seconds.
- No `bufferedAmount` feedback between OkHttp WebSocket and send queue.

## Target Architecture

```
Transport Layer (native service)
  ├─ Sliding window + cumulative per-chunk ACK
  ├─ Timeout → retransmit only unacked chunks
  ├─ Reconnect → resume from last acked chunk index
  ├─ Backpressure: OkHttp queued bytes → high/low water marks
  └─ Error containment: retry N times before escalating to teardown;
      only project persistent failures (>5 s) to JS

UI Layer
  Shows "transferring" or "done". Never sees intermediate retries.
```

## Phase 1: Stop-the-Bleeding (P0)

### T1: Send failure does not tear down connection

- File: `android/native/android/app/src/main/java/com/zterm/android/AndroidConnectionService.java`
- In `sendOrQueue`, when `current.send()` returns false or throws:
  - Mark runtime as degraded (do NOT call `transportFailure`)
  - Retry up to 3 times with 200 ms interval on a worker handler
  - If all retries fail, THEN call `transportFailure`
- Tests: unit test that a single send failure does not trigger backoff;
  3 consecutive failures do.

### T2: Per-chunk ACK + resume for file upload

- Files:
  - `android/src/lib/file-transfer-session-runtime.ts`
  - `android/src/lib/file-transfer-throughput-runtime.ts`
  - Daemon-side file transfer handler
- Client tracks `nextUnackedChunk` per requestId.
- Daemon sends `{requestId, ackedChunks}` progress after each batch write.
- On connection recovery, client resumes sending from `nextUnackedChunk`.
- Remove the current "fail entire upload on any error" behavior.
- Tests: simulate mid-upload disconnect, verify resume from correct chunk;
  verify no duplicate chunks are written daemon-side.

### T3: Debounce physical error projection to JS

- Files:
  - `android/native/android/app/src/main/java/com/zterm/android/AndroidConnectionService.java`
  - `android/src/plugins/AndroidConnectionServicePlugin.ts` (if needed)
- Service tracks `firstFailureAt` per generation.
- Only publish `PHYSICAL_ERROR` if failure persists >5 seconds.
- If transport recovers before 5 s, clear the timer silently.
- JS receives at most one error event per sustained outage.
- Tests: mock a 2-second blip → no JS error event; mock an 8-second outage
  → exactly one error event; recovery clears timer without emitting.

## Phase 2: Transport Resilience (P1)

### T4: Receiver credit flow control

- Replace fixed 8-chunk window with dynamic credit from daemon.
- Daemon sends `WINDOW_UPDATE(requestId, availableChunks)` after each batch.
- Sender blocks when credit reaches 0; resumes on next update.
- Tests: verify sender pauses when credit exhausted; resumes on update.

### T5: OkHttp bufferedAmount feedback loop

- Expose OkHttp's internal queue depth to `sendOrQueue`.
- Set high-water mark (e.g. 256 KB): pause accepting new frames from JS.
- Set low-water mark (e.g. 64 KB): resume draining pendingFrames queue.
- Bridge this to JS via snapshot so the reliable input queue can also use it.
- Tests: verify high-water pause / low-water resume behavior.

### T6: Screenshot transfer uses same resume path

- Refactor screenshot chunked transfer to reuse the file upload session
  runtime (per-chunk ACK + resume).
- Tests: screenshot survives mid-transfer disconnect and completes correctly.

## Phase 3: Binary Data Plane (P2)

### T7: Mux v2 binary frames

- Negotiate `binaryFramesV2` capability during mux-hello.
- Encode file chunks as binary payload (no base64) in mux-channel-binary.
- Maintain v1 JSON fallback for older daemons.
- Eliminates ~33 % wire overhead and repeated JSON.stringify cost.

## Verification Gates

| Gate | Scope | Command |
|------|-------|---------|
| Unit tests | T1–T3 | `./gradlew :app:testDebugUnitTest --tests com.zterm.android.AndroidConnectionServiceTransportTest` |
| Integration tests | T2, T4–T6 | `pnpm --dir android exec vitest run src/lib/file-transfer-session-runtime.test.ts src/lib/file-transfer-throughput-runtime.test.ts` |
| Type check | All | `pnpm --dir android run type-check` |
| Feature registry | All | `pnpm --dir android run test:feature-registry -- --reporter dot` |
| Build + OTA | Release | `pnpm --dir android run build:android` |
| Device smoke | L5 | Install APK → connect → start file upload → toggle airplane mode → reconnect → verify resume completes without user-visible error |

## Success Criteria

1. A brief network blip (<15 s) during file upload does not surface any
   error to the user. Upload completes after reconnection.
2. A single WebSocket send failure does not tear down the physical
   connection.
3. The JS layer receives at most one error notification per sustained
   outage (>5 s).
4. Screenshot transfers survive brief disconnections.
5. All existing tests pass; new red tests lock each behavior.
