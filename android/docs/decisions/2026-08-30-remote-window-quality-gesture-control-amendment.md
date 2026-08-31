# 2026-08-30 Remote-Window Quality, Gesture, Input, and Frame-Control Amendment

Date: 2026-08-30

Status: Active

Feature: `desktop.remote_window_stream`

Supersedes:

- `2026-08-23-remote-window-touch-gesture-arena-amendment.md` in full.
- The `2mbps | 5mbps | 10mbps | 20mbps | fullscreen` product-preset contract.
- Any gate, map, SOP, or test that requires release-time single-finger swipe,
  zoomed single-finger local pan, one-second gesture expiry, or refresh of
  queued continuous-input receive timestamps.

Canonical implementation plan:

- `docs/goals/remote-window-quality-gesture-remediation-plan.md`

## Decision

Remote-window interaction is optimized for bounded frame and input age. The
default preference is `smooth`; `quality` is selectable. A quality profile is
one typed stream-local control value containing bitrate, capture dimensions,
frame rate, maximum frame age, interaction state, and overview budget. The old
Mbps presets are migration input only and must be physically removed after the
stored preference is migrated.

Quality control is single-flight/latest-wins. Client truth is
`appliedProfile`, `desiredProfile`, one `inFlight` revision, one
`queuedLatestProfile`, and a bounded stats cooldown. The daemon applies an
exact per-lane diff:

- bitrate-only updates change sender parameters only;
- cadence or dimensions update the existing `SCStream` configuration;
- target/filter changes update the existing content filter/configuration;
- identical values return an applied no-op;
- no quality update may stop or recreate an `SCStream`.

Network, host capture/encode, Android decode/render, and latency-only pressure
are separate typed telemetry facts. Each adjustment moves one level; a CPU or
render limitation is never reconstructed as a network limitation. Control,
revision, retry, health, and diagnostics stay in typed control resources and
must not enter video-frame, input-action, or other business payload metadata.

## Direct Touch contract

At both 1x and zoomed scale:

- tap emits one remote left click;
- one-finger movement crossing 8 px commits to realtime bounded pixel scroll;
- movement after a 250 ms hold commits to reliable remote drag;
- a stationary 500 ms hold emits one remote right click;
- double tap toggles between 1x and 2x.

With two fingers:

- anti-parallel distance change commits to local pinch zoom;
- same-direction motion at 1x commits to realtime remote scroll;
- same-direction motion while zoomed commits to local canvas pan.

Zoomed pointer-down does not pre-commit local pan. A committed gesture remains
latched until the pointer sequence ends. Gesture duration never makes a
release stale. If a remote down was emitted, pointer-up and pointer-cancel both
produce a reliable release. Touch outside the rendered content rect maps to no
source point; it is never clamped to a remote edge.

Mouse Emulation retains remote pointer move/down/up/drag and remote two-finger
wheel semantics. Pinch remains local. Local mouse-mode pan requires the
explicit hand/pan control and does not reuse the remote-wheel gesture.

## Input delivery contract

Remote-window actions and delivery control are physically separate.

Reliable ordered lane:

- pointer down/up/cancel-release;
- click/double-click/right-click;
- key down/up, committed text, and paste;
- focus, resize, and focus-switch barriers.

Continuous mergeable lane:

- pointer move/hover;
- pixel scroll;
- interaction telemetry.

The client retains only the latest move, accumulates scroll deltas, and flushes
continuous input at no more than 45 Hz for `smooth` or 30 Hz for `quality`.
A reliable barrier first flushes preceding continuous state and then waits for
an ACK/NACK tied to one stable delivery sequence. A bounded retry reuses that
sequence; it never creates a second user action.

The daemon keeps at most two continuous pending entries per target, never
refreshes their receive timestamps, and drops them when their daemon-local age
budget expires. Reliable sequence dedupe and ACK/NACK are independent from the
continuous stale policy. Queue pressure may not drop release, key, click, or
barrier records.

## Frame-control contract

The visible focus canvas is driven by `requestVideoFrameCallback`; one decoded
frame id causes at most one focus `drawImage`. Overview and thumbnail lanes use
their own decoded-frame callbacks and profile cadence. Production does not
retain a display-rAF drawing fallback.

Focus and overview capture/conversion each own at most one pending latest
frame. A newer frame replaces the pending older frame; a frame older than the
active profile's maximum frame age is dropped. Increasing queue depth is not a
valid latency fix.

If the bounded raw path cannot meet both live profile gates, the media owner
must ship one native CVPixelBuffer/WebRTC or VideoToolbox path and physically
remove the production RGBA-stdout path. Two production media paths are
forbidden.

## Ownership and boundaries

- `client.remote_window_overlay` owns preference, client quality state,
  gesture-to-action scheduling, decoded-frame canvas projection, and local
  viewport transforms.
- `resource.remote_window_touch_action` owns Direct Touch and Mouse Emulation
  classification.
- `daemon.remote_window_stream` owns group quality application,
  ScreenCaptureKit configuration, capture/conversion backpressure, input
  delivery admission/dedupe, and OS injection.
- The shared protocol owns the single versioned wire contract, not runtime
  policy or state.

Terminal mirror, sparse buffer, terminal renderer, tmux width, screenshot
frames, and client UI-plugin transport ownership remain forbidden. The daemon
does not own zoom, input mode, active tab, or Android UI state; the client does
not calculate macOS global coordinates or mutate capture truth.

## Required paired evidence

- bitrate-only, in-place cadence/dimension, same-profile no-op, group rollback,
  rejected/busy recovery, latest-wins, cooldown, and cause-split tests;
- 1x/zoomed realtime scroll, zoomed two-finger pan, pinch, hold-drag,
  right-click, five-second release, cancel-release, letterbox-null, and
  mouse-mode tests;
- 120 Hz coalescing, continuous expiry, reliable barrier, stable-sequence
  retry, dedupe, ACK/NACK, and queue-overflow tests;
- decoded-frame draw-once, overview cadence, latest-frame replacement,
  maximum-frame-age, conversion failure, and exactly-once cleanup tests;
- registry/import/function/mainline gates, canonical builds, installed daemon
  and Android identity, real AppKit/Android route A/B, and AGY Review PASS.

## Standard WebRTC boundary (2026-08-31)

The daemon uses the standard WebRTC object model (`RTCPeerConnection`,
`RTCVideoSource`, `RTCRtpSender`) through the installed Node native binding
`@roamhq/wrtc@0.10.0`. “Use standard WebRTC directly” is therefore already the
current protocol and API choice; replacing it with browser WebRTC is not a
local daemon substitution because Node has no browser WebRTC runtime.

Stock-binding probes are recorded in the run evidence:

- the existing `addTrack()` sender path negotiates video;
- an unchanged `getParameters()` → `setParameters()` round-trip fails with
  `InvalidStateError`;
- `addTransceiver(track, { sendEncodings })` yields an `inactive` answer in the
  recvonly offer shape and does not expose `maxFramerate`;
- an `addTrack()` sender has no encoding entry before negotiation, so a complete
  startup encoding profile cannot be installed before negotiation.

Decision: retain standard WebRTC and `addTrack()`, do not add a fork or modify
native WebRTC in this application change set. The daemon must expose a typed
quality-capability result when stock `setParameters()` rejects. It may apply
the selected profile at stream creation/capture setup, but must not claim
runtime bitrate/FPS adaptation until an explicitly authorized compatible native
binding is installed. No fallback media path or silent downgrade is allowed.
