# Terminal Long Input Delivery Test Design

Date: 2026-07-18

## Goal

Long terminal input must preserve exact source text across the platform input channel, current session transport, daemon input queue, and backend tmux/WezTerm write path. Payload semantics stay string-only: chunking may change frame boundaries, not text content or order.

## Architecture Mapping

| layer | owner feature | owner path | resource edge |
| --- | --- | --- | --- |
| Android native IME commit | `terminal.keyboard_ime` | `android/native/android/app/src/main/java/com/zterm/android/ImeAnchorInputLogic.java` | `resource.platform_input_channel -> resource.session_transport` |
| Android session input send | `terminal.transport_lifecycle` | `android/src/contexts/session-context-input-runtime.ts` | `resource.session_transport -> resource.transport_subscriber` |
| daemon input receive/drop | `terminal.daemon_input` | `android/src/server/terminal-message-runtime.ts` | `resource.transport_subscriber -> resource.daemon_input_queue` |
| daemon backend write queue | `terminal.daemon_input` | `android/src/server/terminal-control-runtime.ts` | `resource.daemon_input_queue -> resource.backend_session -> resource.tmux_session` |

Mainline call IDs:

- `daemon_mainline:Runtime->Message`
- `daemon_mainline:Message->Control`
- `daemon_mainline:Control->Tmux`

Forbidden paths:

- UI must not split by terminal rows or mutate rendered buffer as an input echo.
- Existing `input.payload` must not become an object envelope; daemon still rejects non-string payloads as `input_invalid`.
- daemon must not re-coalesce chunks into a single oversized `send-keys -l -- <payload>` argument.

## White-Box Gates

- Shared chunk helper:
  - splits by UTF-8 byte budget.
  - preserves `chunks.join('') === source`.
  - does not split surrogate pairs across chunk boundaries.
- Android native:
  - long IME commit emits multiple ordered `EMIT_INPUT` events before one `CLEAR_EDITABLE`.
  - every emitted native event stays under the bridge byte budget.
- Android client transport:
  - long input becomes multiple `{ type: 'input', payload: string }` frames.
  - every frame is under the daemon frame budget.
  - backpressured transport still sends zero chunks and closes explicitly.
- daemon message runtime:
  - payload exactly at the frame max is accepted.
  - payload over the frame max returns `input_too_large` and never calls `handleInput`.
- daemon control runtime:
  - small same-microtask input still coalesces.
  - coalesced burst groups split before exceeding the 256-byte tmux literal-write budget.
  - one oversized item resolves only after all of its tmux chunks finish.
  - input queued while an earlier tmux write is in flight is drained in order.

## Black-Box Gates

- `daemon:mirror:close-loop` remains required for daemon/tmux input path health.
- `long-input-echo` sends a source payload larger than one client chunk through the daemon WebSocket and keeps two assertions separate:
  - source-to-target truth: disable terminal echo first, stream the payload into `cat > file`, terminate with Ctrl-D, and compare source SHA-256 with the SHA-256 printed by tmux from the target file. This gate proves the platform input / session transport / daemon input queue / backend write path preserves bytes and order.
  - mirror recovery truth: after the byte-exact target digest appears, wait for daemon replayed mirror history to match the current tmux visible oracle. This gate proves long input does not leave the mirror/client replay stuck on stale rows.
- The digest marker and digest are printed on separate terminal lines so terminal wrapping cannot hide a correct digest behind an artificial string-contains failure.
- If source-to-target digest passes but mirror recovery fails, the report must classify the failure as mirror recovery, not input byte loss.

The 256-byte tmux write budget is intentionally separate from the 64 KiB client
WebSocket frame budget. Local macOS tmux probes showed two independent limits:
16,000 literal bytes is accepted while 20,000 fails with `command too long`;
after avoiding that argv limit, long here-doc delivery was still byte-unstable
at 512 bytes and above. The first byte-exact source/target digest pass was
256-byte writes with a 2 ms inter-write settle.

## Known Gaps

- Local unit gates prove frame and write semantics. They do not prove a locked physical Android device accepted a long IME commit through the real Capacitor bridge.
- L5 Android delivery requires a rebuilt APK plus device smoke when an online ADB device is available.
