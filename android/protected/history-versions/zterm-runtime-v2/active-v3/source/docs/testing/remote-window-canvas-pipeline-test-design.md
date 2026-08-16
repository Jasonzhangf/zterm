# Remote Window Canvas Pipeline Test Design

## Scope

Feature id: `desktop.remote_window_stream`

This gate covers the new remote-window canvas pipeline: daemon-side raw bitmap canvas, layout metadata, encoded canvas stream, optional focus stream, and Android canvas projection. It does not replace the existing single-target remote-window stream tests.

## Capability gates

1. Mac encoder capability
   - Enumerate VideoToolbox encoders on the host.
   - Create H.264 and HEVC compression sessions.
   - Record supported compression properties.
   - Assert ROI is enabled only when a verified ROI property exists and a set-property probe succeeds.
   - Current 2026-07-29 result: H.264/HEVC VideoToolbox works; explicit `"RegionOfInterest"` property set returned `-12900`; therefore ROI is not available on this Mac/SDK.

2. Synthetic encode benchmark
   - Encode a 1920x1080@60 synthetic source for five seconds with H.264 VideoToolbox at 5 Mbps.
   - Encode the same source with HEVC VideoToolbox at 5 Mbps.
   - Verify output with `ffprobe`: codec, dimensions, duration, frame rate, and bit rate.
   - Preserve sha256 and command evidence under `android/evidence/remote-window-canvas-encoding-YYYYMMDD/`.

## Unit gates

1. Layout planner
   - Input: two or more app windows with bounds, scale, visibility, app grouping, focus, and z-order.
   - Output: one compact canvas size, source rects, canvas rects, z-order, focus target, and monotonic layout generation.
   - Positive: new window, removed window, moved window, focus change, and resize each produce expected generation and stable target ids.
   - Negative: invalid/zero-size/minimized windows are explicit layout errors and must not fall back to full desktop.

2. Canvas projection
   - Android projection consumes one canvas video plus layout metadata.
   - Each visible child window is a crop of the same canvas stream.
   - Focus stream, when present, overlays only the active target and does not change background canvas identity.
   - Negative: projection must not request thumbnail screenshots or start per-window video streams while canvas mode is active.

3. Input mapping
   - Input from a projected child maps through the exact layout generation and target id.
   - Stale generation is rejected explicitly.
   - Android does not compute macOS global coordinates from DOM geometry alone.

4. Protocol validation
   - Canvas mode, layout generation, source rects, canvas rects, focus stream id, and explicit capability diagnostics are typed.
   - Missing layout or unknown target is a protocol error.
   - ROI-disabled hosts choose declared dual-stream mode, not hidden fallback.

## Integration gates

1. Daemon canvas lifecycle
   - `select app group -> layout -> raw canvas -> encode -> publish layout -> stop`.
   - Stop releases compositor, encoder, focus stream, timers, and layout subscriptions exactly once.
   - Capture/encode errors return explicit `remote-window-error` and preserve no stale canvas truth.

2. Stream storm prevention
   - Opening an app group with three windows starts one canvas stream and at most one focus stream.
   - Focus switch updates focus metadata and focus stream binding.
   - Focus switch must not restart the canvas stream or start streams for every sibling.

3. Screenshot loop prevention
   - Canvas mode disables sibling thumbnail refresh as a live video source.
   - One-shot screenshot remains allowed only through the explicit screenshot button and `resource.remote_screenshot`.

4. Performance budget
   - Layout updates are metadata-only unless raw canvas content changes.
   - Background windows may use lower frame cadence/bitrate only through canvas/focus policy, not per-window polling.
   - Test records frame counts, layout generation counts, stream starts, stream stops, screenshot requests, and control-message counts.

## Live Mac gates

1. Reflowed app-group pixel oracle
   - Launch two or three marked windows with known colors/text.
   - Build one reflowed canvas.
   - Assert the canvas pixel regions match source markers and layout JSON coordinates.
   - Move/resize/add/remove one window and assert only layout generation changes plus expected canvas region movement.

2. Focus dual-stream oracle
   - With ROI unavailable, the future canvas mode starts low-rate canvas plus high-rate focus stream; the currently implemented startup slice uses low-rate `preview` plus high-rate `focus`.
   - Assert background remains visible through canvas.
   - Assert focused window has higher frame cadence/bitrate evidence.
   - Switch focus and assert stream ids/generation update according to the declared mode.

3. No fallback oracle
   - Force compositor failure.
   - Assert explicit error.
   - Assert no full-display capture, screenshot loop, terminal render, or stale image path is used.

## Installed Android gates

1. Projection gate
   - Install current APK.
   - Start canvas mode against a Mac daemon.
   - Verify one canvas receiver renders multiple cropped windows.
   - Verify close controls and safe boundaries remain reachable in floating and fullscreen modes.

2. Input gate
   - Tap/click one projected child.
   - Assert outgoing `remote-window-input` includes target id and layout generation.
   - Assert daemon rejects stale generation after a forced layout update.

3. Performance gate
   - Run multi-window preview for at least 60 seconds.
   - Assert preview does not freeze.
   - Assert stream start/stop count remains bounded: one canvas stream plus optional one focus stream, not one stream per child refresh.

## Required closeout evidence

- Mac encoder capability output.
- ffmpeg benchmark and ffprobe output.
- Unit test summary for layout/projection/protocol.
- Live Mac pixel oracle summary.
- Installed Android receiver/input/performance summary.
- Explicit list of unsupported capabilities, including ROI state.
