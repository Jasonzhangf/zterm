# 2026-10-02 Remote-Window RustDesk Comparison and UX Quality Slice

## Purpose

This note records the RustDesk comparison requested for the remote-window
streaming UX/quality slice. It is a reference input, not a second runtime
contract: zterm's active ownership and wire contracts remain those in
`2026-07-19-remote-window-stream-truth.md` and
`2026-08-30-remote-window-quality-gesture-control-amendment.md`.

Source inspected: `rustdesk/rustdesk` `master`
`fada664df7a294d1d1a9ca3e7cd3637069122f17` (2026-09-30), AGPL-3.0.

## Findings

| # | RustDesk behavior | Evidence | What zterm should learn | zterm boundary |
| --- | --- | --- | --- | --- |
| 1 | Live encoding leaves `keyframe_interval` unset; the explicit 240-frame interval is reserved for recording. | `src/server/video_service.rs` encoder configs; `libs/scrap/src/common/hwcodec.rs` `DEFAULT_GOP = i32::MAX`; `libs/scrap/src/common/vram.rs` `unwrap_or(MAX_GOP)` | Treat long GOP as the live/streaming default and do not spend bitrate twice on recording-style keyframes. | `@roamhq/wrtc` exposes no verified GOP/keyframe control, so keep recording that capability gap rather than adding an unrecognized wire field. |
| 2 | Central `VideoQoS` controller keeps per-viewer delay history, FPS, bitrate ratio, stall ticks, and separate good/bad confirmations. | `src/server/video_qos.rs` `UserDelay`, `VideoQoS`, `limit_fps_change`, `recover`, `ratio_reduction` | Keep adaptive control as one bounded, per-viewer state machine with explicit confirmation and recovery, not scattered UI timers. | zterm's quality control stays stream-local and acknowledged: `appliedProfile`/`desiredProfile`, one in-flight revision, latest-wins; the daemon applies an exact per-lane diff. |
| 3 | Delay is delay-above-baseline, not raw RTT. The controller subtracts a learned RTT baseline before judging congestion. | `src/server/video_qos.rs` `avg_delay`, `RttCalculator`, `DELAY_THRESHOLD_150MS` | Separate path RTT from queue/build-up delay; do not label normal RTT as congestion. | zterm already splits network, host capture/encode, Android decode/render, and latency-only facts; keep using that split. |
| 4 | Bitrate is reduced before frame rate for bandwidth pressure; FPS has a floor while bitrate can still move. | `src/server/video_qos.rs` comment and `limit_fps_change`/`ratio_reduction` flow | Prefer small bitrate steps first to preserve responsiveness; reserve FPS cuts for confirmed sustained pressure. | zterm's bounded one-level ladder already does this. Current production stats collection deliberately does not drive ABR until a measured trustworthy signal exists. |
| 5 | Congestion requires confirmation: two consecutive bad samples, or an outstanding probe past two timeout ticks. One slow reply is jitter. | `src/server/video_qos.rs` `needs_bitrate_reduction`, `consecutive_bad_samples`, `stall_ticks` | Never downgrade on a single sample; require repeated or severe evidence and then move one step. | zterm's two-sample confirmation and 12-second stable restore mirror this, but current wiring keeps adaptive cause at `none` while stats are diagnostic-only. |
| 6 | Recovery is bounded and staged: restore in small steps, cap returned level, and roll back quickly if the restored level congests again. | `src/server/video_qos.rs` `recover`, `fps_before_congestion`, `RESTORE_GUARD_SAMPLES` | Restore gradually and guard against oscillation. | zterm's one-level restore after a stable window is the local equivalent. |
| 7 | FPS and bitrate changes are applied in place through the encoder rather than restarting capture. | `libs/scrap/src/common/hwcodec.rs` `set_quality` -> `set_bitrate`; `libs/scrap/src/common/vram.rs` `set_quality` | Quality changes must never tear down the capture or transport. | zterm's typed quality transaction already requires bitrate-only updates to mutate sender parameters and cadence/dimensions to update `SCStream` in place with zero stop/start calls. |
| 8 | Quality change support is explicit; unsupported hardware reports it instead of pretending success. | `hwcodec.rs` `support_changing_quality` excludes `vaapi`; `video_service.rs` records it | Model capability explicitly; unsupported means typed failure, not a silent fallback. | zterm's `setParameters()` rejection is reported as quality unsupported while video stays alive; do not fabricate encodings. |
| 9 | Receiver/display queue is latest-only per display: a new frame replaces the pending frame and the old one is closed. | `flutter/lib/models/web_video_frame_queue.dart` `_pending.remove(display)` and generation invalidation | Bound latency at the receive/present boundary; never grow queue depth to hide slowness. | zterm already has bounded per-lane latest capture/conversion; keep one pending latest frame and drop by max frame age. |
| 10 | Mobile stream controls live in a collapsible bottom action bar / gesture-help shell rather than a permanent full toolbar. | `flutter/lib/mobile/pages/remote_page.dart` `_showBar`, `_showGestureHelp`, floating expand/collapse action button, `getBottomAppBar`, `getGestureHelp` | Preserve video area: gate low-frequency controls behind an explicit expansion and keep a single collapse affordance. | zterm's locked toolbar keeps primary actions visible and puts low-frequency display/quality controls under More; the More sheet is now an anchored overlay that dismisses on selection or close. |
| 11 | Multi-viewer QoS keeps per-viewer state and starts each viewer at `INIT_FPS`, adapting from that viewer's own target and cap. | `src/server/video_qos.rs` `INIT_FPS`, `users`, per-user target/cap comments | Do not let one viewer's spike force the minimum onto another viewer. | zterm's remote-window stream is stream-local; when multi-viewer support arrives, keep the same per-subscriber isolation instead of a global client-state owner. |

## Applied in This Slice

- More/stream settings no longer expands the locked toolbar; it overlays the
  video and dismisses after a select change or via the close button.
- Locked toolbar status and gesture hint share one compact meta row.
- Composite fallback thumbnails are bounded and are not duplicated beside the
  app-group sibling rail; the rail height is bounded so it cannot consume a
  quarter of the phone viewport.
- Thumbnail canvases are keyed by daemon `windowId`, matching the daemon canvas
  owner.
- The first/active stream now owns quality requests by exact stream readiness,
  so quality changes bind to the started stream instead of a lagging focus ref.
- The default smooth profile baseline is raised to 3 Mbps (1.5 Mbps x 2), and
  the first smooth degradation step is 2.5 Mbps rather than 2 Mbps.

## Deliberately Not Changed

- No GOP/keyframe wire field or native WebRTC fork.
- No live ABR from the current diagnostic-only stats samples. RustDesk's
  controller is the target model, but zterm must first establish trustworthy
  measured signals and keep quality/revision/health on the typed control path.
- No screenshot fallback, terminal mirror, or second media path.

## Verification

- `pnpm run test:feature-registry -- --reporter dot`
- `pnpm run test:remote-window-ui`
- Focused remote-window / More / WindowGroup tests
- `pnpm run type-check`
- `git diff --check`
