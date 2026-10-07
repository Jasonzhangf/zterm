# 2026-08-30 Remote-Window Quality, Gesture, Input, and Frame-Control Amendment

Date: 2026-08-30

Status: Active

Feature: `desktop.remote_window_stream`

Supersedes:

- `2026-08-23-remote-window-touch-gesture-arena-amendment.md` in full.
- The `2mbps | 5mbps | 10mbps | 20mbps | fullscreen` product-preset contract.
- Any gate, map, SOP, or test that requires release-time single-finger swipe,
  one-second gesture expiry, or refresh of queued continuous-input receive
  timestamps.

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

Scope: the Direct Touch contract below applies to standalone floating,
embedded fullscreen, and the standalone fullscreen overlay. The embedded
resource-drawer half-sheet preview (`embedded && mode === "floating"`) is a
passive preview: it does not run this gesture arena, does not change zoom/pan,
and emits no remote input. The drawer grip is the only affordance that promotes
the half-sheet preview to embedded fullscreen. There is no video double-tap
or other Direct Touch promotion from the half-sheet preview.

At 1x:

- tap emits one remote left click;
- one-finger movement crossing 8 px commits to realtime bounded pixel scroll;
- movement after a 250 ms hold commits to reliable remote drag;
- a stationary 500 ms hold emits one remote right click;
- double tap toggles to 2x.

At zoomed floating scale:

- one-finger movement pans the local canvas and emits no remote input;
- two-finger same-direction vertical motion commits to realtime remote scroll;
- anti-parallel distance change commits to local pinch zoom;
- double tap toggles back to 1x.

At zoomed fullscreen scale:

- one finger is a complete no-op: tap, hold, drag, local pan, and double-tap do
  not emit remote input or change the local projection;
- two-finger same-direction vertical motion commits to realtime remote scroll;
- anti-parallel distance change commits to local pinch zoom;
- only the two-finger gestures above remain active until the viewport returns
  to 1x.

With two fingers:

- anti-parallel distance change commits to local pinch zoom only, never remote scroll;
- same-direction motion at 1x and zoomed scale commits to realtime remote scroll.

Zoomed pointer-down starts local single-finger pan in floating and a suppressed
single-finger sequence in fullscreen; a second finger upgrades either to
two-finger classification. A committed gesture remains latched until the
pointer sequence ends. Gesture duration never makes a release stale. If a
remote down was emitted, pointer-up and pointer-cancel both produce a reliable
release. Touch outside the rendered content rect maps to no source point; it is
never clamped to a remote edge.

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
- 1x one-finger realtime scroll, zoomed floating one-finger local pan, zoomed
  fullscreen one-finger no-op, zoomed two-finger same-direction realtime scroll,
  pinch, hold-drag, right-click,
  five-second release, cancel-release, letterbox-null, and mouse-mode tests;
- 120 Hz coalescing, continuous expiry, reliable barrier, stable-sequence
  retry, dedupe, ACK/NACK, and queue-overflow tests;
- decoded-frame draw-once, overview cadence, latest-frame replacement,
  maximum-frame-age, conversion failure, and exactly-once cleanup tests;
- registry/import/function/mainline gates, canonical builds, installed daemon
  and Android identity, real AppKit/Android route A/B, and AGY Review PASS.

## Standard WebRTC boundary (2026-08-31)

The offer-owner and sender-encoding contract below is superseded by
`2026-08-31-remote-window-sender-offer-contract.md`. The older `addTrack()`
answerer observations remain historical evidence only and must not be used as
the implementation target.

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

## 2026-10-02 execution proposal: independent limits and operable zoom

Status: design candidate only. The historical clauses above remain the active
runtime contract until this task's implementation, paired black-box/live
evidence and independent architecture review pass and the verified candidate
is integrated. This section does not claim a native binding capability change.

Design carrier: `2026-10-02-stream-control-design.md`; execution plan is the
reviewed `remote-window-stream-execution-plan-2026-10-03.md`. The four proposed
start/quality/input-delivery/stop graphs model independent control requests.
They are not yet registered executable Operators. Existing Phase4 graph and
consumer are admission/parity scope, not proof of the four live object flows.

Proposed replacement of the zoomed Direct Touch clauses:

- At zoomed floating and fullscreen scale, an explicit remote-operation mode
  supports tap, 250 ms hold-drag, stationary 500 ms right click, and bounded
  realtime one-finger scroll. It uses the selected rendered crop and local
  viewport transform; outside-content touches still map to no point.
- Local hand/pan mode is explicit, exclusive with remote operation, and keeps
  one-finger local panning without emitting remote actions. Prefer reusing the
  existing hand/pan affordance; do not create another gesture owner.
- Two-finger pinch and same-direction scroll remain mutually exclusive and
  latched for the pointer sequence. Pointer cancel/up reliably releases an
  emitted remote down. Duration does not invalidate release.
- The embedded half-sheet remains passive. Its visible promotion affordance
  enters embedded fullscreen through the actual drawer lifecycle; no private
  handler, input-context shortcut or double-tap promotion is introduced.

Proposed replacement of the reliable per-record wait boundary:

- Reliable actions remain ordered and deduplicated. The first repair retains
  the current single-flight owner, removes proved synchronous native focus
  cost, and prevents reliable records from expiring merely because they waited
  in the queue. A finite in-flight window requires separate high-RTT/target-side
  evidence and design admission; it is not a mandatory speculative change.
- A barrier flushes preceding continuous deltas, waits for prior required
  delivery outcomes, and blocks following dependent actions. Unrelated media
  work must not own input delivery progress.
- A bounded retry retains the delivery sequence of the same user action.
  Missing ACK/NACK produces an explicit delivery failure; it must not silently
  invent success or hide release in an unreachable queue. Stop/transport
  teardown owns release of this stream's held input, not another stream's.
- Move is latest-wins; scroll preserves accumulated deltas. Existing age/rate
  admission and stable dedupe continue to apply.

Independent quality limits:

- Preference, explicit Mbps cap and FPS ceiling are separate control values.
  Preference changes retain manual limits; saved FPS is inherited. Settings
  edit a draft; Cancel applies and persists nothing; Apply is one transaction.
- Requested, last acknowledged applied and trustworthy actual stats have
  distinct projections. Pending, rejected, unsupported or disconnected cannot
  overwrite the last acknowledged value or appear as successfully applied.
- Pressure bitrate must not exceed either the user cap or last acknowledged
  cap; the sum of lane allocations stays within the stream cap. Recovery has
  stable confirmation and never raises a user ceiling.
- Runtime support must be established from the canonical binding and real
  ACK/encoder output. This proposal cannot override a typed unsupported result.

Required paired gates replace the affected historical no-op/stop-and-wait
expectations only after the semantics above pass design review: zoom tap/drag,
exclusive local pan, two-finger arbitration and cancel release; real high-RTT
ordered delivery/barriers/stable retry/dedupe/release; independent Mbps/FPS,
latest-wins ACK/NACK and actual caps; first visible target marker and local
exit/stop-failure resource results. Exact commands and external assertions
remain D0 admission requirements, not claims that tests already exist or pass.

R2 field/owner freeze is recorded in `2026-10-02-stream-control-design.md`:
reuse the current quality request/result identities and profiles; retain the
last exact ACK within the existing quality owner; typed unsupported remains a
rejected wire result with an explicit capability code. Client-local delivery
settle/cancel outcomes do not forge daemon ACK/receive timestamps. Native focus
optimization, client delivery termination, daemon held-input release, and
destructive window-close results remain separately scoped admission items.

## 2026-10-04 superseding local mode and gesture contract

Status: design contract. This section supersedes the zoomed single-finger
clauses in "Direct Touch contract" and the "2026-10-02 execution proposal:
independent limits and operable zoom" replacement clauses above. The
historical clauses and the installed 3207 red evidence remain recorded as
evidence; they are not the implementation target. The bounded business design,
Chinese semantic diagrams, state machines, black-box acceptance, and
implementation allowlist live in `2026-10-02-stream-control-design.md`
(appendix "2026-10-04 本地模式与手势最终契约"). Independent design review is
still required before product repair.

The user confirmed the target semantics against installed 3207:

- Client mode (`local preview` / `fullscreen`) is an independent local display
  state. Switching mode changes only the local projection. It does not write
  remote window geometry, quality profile, stream start, or stream stop. It
  does not restart or replace the stream/track and does not wait for a resize
  ACK. The same stream identity, receiver track, and source ratio persist
  across `half <-> fullscreen` cycles.
- Local viewport (`scale`, `panX`, `panY`, `displayMode`) is an independent
  local state owner. It is measured from the real surface rect and clamped
  locally. It never becomes daemon truth.
- Media lifecycle readiness is an independent state owner. Readiness means an
  actual capture plus an actual decoded frame on the client, not an offer,
  answer, or local-description intent.
- Gesture sequence is an independent state owner. A new user gesture is a new
  execution; the lifecycle may cycle across executions, but no execution
  creates a graph cycle.

At zoomed scale, one finger pans the local viewport and emits no remote input.
Two-finger same-direction motion commits to realtime remote scroll. Pinch
commits to local scale only. The touch/mouse input mode cannot flip the
zoomed-single-finger semantic. The embedded half-sheet preview stays passive.
When a second finger arrives, it ends the prior single-finger ownership; the
implementation must not arbitrarily restore an already-applied local pan
unless the contract explicitly requires it. Pointer cancel and pointer up
release any remote down that this gesture owns exactly once, and the terminal
pointer count must reach zero. Focus and capture transfer follows the local
projection and cannot trigger unrelated stream operations.

An explicit remote resize is a distinct input operation with a real geometry
readback. It is not an automatic side effect of mode, orientation, container
size, or display-mode change. The existing `requestRemoteTargetFillResize`
automatic effects are a known wrong edge and are not part of this contract.
