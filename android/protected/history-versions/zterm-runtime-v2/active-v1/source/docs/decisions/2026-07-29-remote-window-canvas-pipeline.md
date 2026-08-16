# 2026-07-29 remote window canvas pipeline

## Purpose

This decision defines the next remote-window streaming architecture for multi-window application streaming. It extends `desktop.remote_window_stream` without replacing the existing single-target stream contract.

The new path is a remote canvas pipeline:

1. raw bitmap layer: daemon-owned desktop-pixel truth.
2. layout layer: daemon-owned source-window-to-canvas mapping.
3. encode layer: daemon-owned encoded resolution, bitrate, and frame cadence.
4. client projection layer: Android crops and arranges one received canvas stream plus optional focus stream. Android does not own macOS coordinates.

## Mac encoding probe

Probe host:

- macOS `26.4.1`, Darwin `25.4.0`
- Apple M3 Ultra, 80-core GPU, Metal 4
- ffmpeg path: `/opt/homebrew/bin/ffmpeg`

VideoToolbox encoders available:

- `h264_videotoolbox`
- `hevc_videotoolbox`
- `prores_videotoolbox`

Benchmark evidence under `android/evidence/remote-window-canvas-encoding-20260729/`:

| sample | codec | size | frame rate | bit rate | duration | sha256 | observed encode speed |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |
| `h264-vt-1080p60.mp4` | H.264 VideoToolbox | 1920x1080 | 60 fps | 5.06 Mbps | 5.0s | `b0110114fd649f57e5c5dca8e697221731e5ce52bc4f8ea90b7a22a2e8515706` | about 154 fps / 2.56x |
| `hevc-vt-1080p60.mp4` | HEVC VideoToolbox | 1920x1080 | 60 fps | 5.12 Mbps | 5.0s | `4798e0d2cb2909354afd23bfee216291cae1f8904a3a69a2afd19d40f56ef174` | about 243 fps / 4.04x |

VideoToolbox capability probe:

- `VTCompressionSessionCreate` returned status `0` for H.264 and HEVC.
- Supported keys included `AverageBitRate`, `DataRateLimits`, `ExpectedFrameRate`, and `SpatialAdaptiveQPLevel`.
- Public Swift SDK did not expose `kVTCompressionPropertyKey_RegionOfInterest`.
- Setting raw CFString property `"RegionOfInterest"` returned `-12900` and the supported-property dictionary did not list it for H.264 or HEVC.

Decision: this project must not assume native VideoToolbox ROI on the current Mac/SDK. ROI support remains a future explicit capability gate. The target design uses canvas reflow and a declared optional focus stream instead of hidden ROI fallback. The current implemented startup slice is only `preview` plus `focus`; persistent app-group canvas resources remain design status until compositor/layout/projection gates land.

## Product contract

Remote application streaming can operate in two explicit canvas modes:

1. `canvas-full-display`: raw layer is the desktop/display region. This is allowed for proof and full desktop streaming, but it is not the default multi-window mode.
2. `canvas-reflowed-app-group`: daemon lays selected application windows into a compact virtual canvas, crops before encode, and publishes source-to-canvas layout metadata. This is the default for multi-window preview and application group streaming.

When a new window appears or a window moves/resizes, the daemon publishes a new layout generation. The low-rate canvas stream remains one media stream; Android updates crop rectangles from layout metadata instead of starting one stream per window.

Focus quality is explicit:

- Preferred future path: one encoded canvas stream with ROI metadata if the active Mac encoder advertises a verified ROI property.
- Current implemented startup slice: one low-bitrate `preview` stream for first paint, then one high-quality `focus` stream for the active window. This is not the persistent app-group canvas pipeline.

The future canvas/focus dual stream is not a hidden fallback. It is a declared design mode selected because the current Mac/SDK probe did not expose VideoToolbox ROI.

## Resource ownership

New resources under `desktop.remote_window_stream`:

- `resource.remote_window_canvas_raw`: daemon-owned raw bitmap truth. It may represent the full display or a reflowed application-group canvas at desktop-pixel resolution.
- `resource.remote_window_canvas_layout`: daemon-owned layout generation, source window rectangles, canvas rectangles, z order, focus target, and generation clock.
- `resource.remote_window_canvas_encode`: daemon-owned encoded canvas stream configuration and sender state.
- `resource.remote_window_focus_stream`: daemon-owned optional high-quality focus stream when ROI is unavailable or disabled.

Existing resources keep their boundaries:

- `resource.remote_window_stream` remains the daemon/native catalog, coordinate manifest, capture, media, input, and cleanup owner.
- `resource.remote_window_overlay` remains Android projection and intent only.
- `resource.remote_window_touch_action` remains client touch/action classification and dispatch evidence.
- terminal mirror/buffer/renderer resources remain forbidden as video truth.

## Lifecycle

```text
catalog
  -> select app group
  -> resolve source windows
  -> compute canvas layout generation
  -> capture raw bitmap layer
  -> crop/reflow into canvas raw layer
  -> encode low-rate canvas
  -> publish layout metadata
  -> optionally encode focus stream
  -> Android projects/crops canvas views
  -> input maps through daemon layout generation
  -> stop/cleanup
```

Layout generation is part of the protocol contract. Android input must include the selected `layoutGeneration` or explicit target identity so the daemon can reject stale crop/input mappings instead of guessing.

## Module split

Top-down implementation modules:

| layer | owner module | planned files | responsibility |
| --- | --- | --- | --- |
| shared protocol | `shared.contract` | `packages/shared/src/connection/protocol.ts` | canvas mode, layout generation, source/window/canvas rectangles, stream start/status/error messages |
| daemon layout | `daemon.remote_window_stream` | `src/server/remote-window-canvas-layout.ts` | compact app-group layout, stable generation, focus/z-order, stale-layout rejection |
| daemon compositor | `daemon.remote_window_stream` | `src/server/remote-window-canvas-compositor.ts` | crop/reflow source windows into the raw canvas bitmap before encode |
| daemon encoder | `daemon.remote_window_stream` | `src/server/remote-window-canvas-encoder.ts` | VideoToolbox/WebRTC sender settings, low canvas stream, optional focus stream, explicit ROI capability result |
| daemon runtime facade | `daemon.remote_window_stream` | `src/server/remote-window-stream-daemon.ts` | control-message wiring only; no layout/compositor logic growth |
| client projection | `client.remote_window_overlay` | `src/lib/remote-window-canvas-projection.ts`, `src/components/terminal/RemoteWindowOverlay.tsx` | consume layout metadata, crop one canvas video into visible windows, bind focus stream, emit intent only |
| tests/probes | same owners | focused test files plus live probes | prove layout, encode, projection, no screenshot loop, no per-window stream storm |

## Explicit non-goals

- No multi-window screenshot refresh loop as the business video source.
- No terminal buffer, sparse rows, renderer output, or screenshot fallback as stream truth.
- No Android-owned macOS coordinate computation.
- No hidden switch from ROI to dual stream; capability failure is visible in diagnostics and mode selection.
- No per-window WebRTC stream for every sibling window.
- No silent full-display fallback when app-group reflow fails.

## Implementation order

1. Lock protocol and resource map for canvas resources.
2. Add pure layout planner and tests.
3. Add Mac encode/capability probe gate.
4. Add compositor/encoder slice behind explicit canvas mode.
5. Add Android canvas projection from metadata.
6. Add live Mac and installed-phone gates.

Code implementation must start only after the design, test design, resource registry, function map, and mainline call map are in sync.
