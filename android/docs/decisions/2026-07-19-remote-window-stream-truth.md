# 2026-07-19 remote window stream truth

## Purpose

This decision defines the first architecture contract for remote desktop window video streaming from a daemon host to Android. It is separate from terminal buffer/render truth and separate from one-shot remote screenshot file transfer.

## Product Contract

Remote window stream starts from the Android floating entry. The old floating quick entry may be hidden or repurposed while this feature is under construction. Tapping the floating entry opens a picker:

1. Choose a remote app/window.
2. If the app is iTerm2, enumerate iTerm2 tabs/panes and the tmux client/session mapping.
3. Choose one window or pane target.
4. Start a floating live video overlay sized from the selected target crop/window aspect ratio.
5. Resize the floating overlay from its edge while preserving the selected source aspect ratio, and drag the floating overlay by its toolbar to reposition it without stealing video/input gestures.
6. Use the explicit fullscreen button next to close, or double tap the video surface, to enter fullscreen. Fullscreen keeps local drawing/input aspect-fit and requests remote target resize fill only for ordinary app-window targets once a stream surface is available.
7. Android system Back in fullscreen shrinks back to floating mode.
8. The fullscreen top-right minimize button also shrinks back to floating mode.
9. Fullscreen preserves source aspect ratio locally. The default fill strategy sends a remote target resize request for the current phone surface for ordinary app-window targets instead of doing a local cover/crop; iTerm2 app-window and pane targets are read-only with respect to window geometry so streaming never changes an iTerm shell size. The manual fill control reissues the same owner request only for resizable ordinary app-window targets. Floating and fullscreen support pinch zoom from fit to enlarged and back to 1x; zoomed floating keeps local canvas pan, while zoomed fullscreen one finger is a complete no-op. Two-finger same-direction motion sends remote scroll, anti-parallel motion remains local pinch, and there is no minimap/viewport overlay.
10. Opening the Android IME lifts the target-locked floating preview by the same bottom inset as the QuickBar so the preview remains visible above the keyboard. In fullscreen, the same bottom inset is consumed as overlay padding and `bottomChromeInsetPx` may auto-lift the projection. At 1x, one-finger touch remains remote input: tap sends one `click`, movement crossing 8 px emits realtime bounded pixel scroll, movement after a 250 ms hold emits reliable remote drag, and a stationary 500 ms hold sends one right click. At zoomed floating scale one-finger movement stays local; at zoomed fullscreen scale one finger is a complete no-op.
11. Zoomed pointer-down does not pre-commit remote action. A committed one-finger suppression stays latched until release; pointer-cancel releases any remote down. Touch outside the rendered content rect returns no source point rather than clamping to a remote edge.
12. Target-locked two-finger coherent same-direction movement emits realtime remote scroll at both 1x and zoomed scale. Anti-parallel relative-distance change emits local pinch zoom only. Once committed, scroll, local suppression, and pinch cannot switch or dual-dispatch during the same pointer sequence.
13. The close button tears down the stream.
14. Floating and fullscreen overlays expose a screenshot button. It captures the selected desktop app/window target through the existing remote screenshot/file-download pipeline, using the target manifest to request either the macOS window id or normalized pane crop rectangle, then saves the PNG on Android. Screenshot capture is not remote input and must not focus or raise the desktop app.
15. When the Android app goes to background, an active remote-window stream is explicitly stopped and the overlay closes instead of keeping ScreenCaptureKit/WebRTC alive offscreen. Foreground return does not auto-resume a hidden stream; the user must reopen the overlay.

### Embedded resource-drawer preview boundary (2026-09-19)

The resource drawer embeds the remote window in two presentations:

- `halfSheetPreview`: the `embedded && mode === "floating"` container. It is a
  passive preview only. It must not publish a remote-window input context and
  must not send pointer, scroll, gesture, wheel, or key events. It must not
  perform local pinch/pan projection either. The explicit drawer grip is the
  only half-sheet-to-fullscreen affordance; the video surface must not promote
  itself with double-tap or any Direct Touch gesture.
- `embeddedFullscreen`: the `embedded && mode === "fullscreen"` container. It
  keeps the full Direct Touch and Mouse Emulation contract below.

Standalone (non-embedded) floating keeps the existing floating interaction
contract. This boundary applies only to the embedded half-sheet preview.

### Fullscreen gesture and close amendment (2026-09-19)

This amendment resolves the real-device feedback where zoomed fullscreen
two-finger motion only moved the local projection, a single tap did not reach
the remote target, and the remote close action could leave the overlay stuck.

- `client.remote_window_overlay` owns the fullscreen/floating projection and
  the local stream teardown for close. The remote close action first emits the
  existing `close-window` business event to the target, but local teardown must
  run even when that event is unsupported, unconfigured, or rejected by the
  input dispatcher. A missing dispatcher must not strand the overlay in
  `targetLocked` or `fullscreen`.
- Back and minimize keep their existing shrink semantics: they exit fullscreen
  to floating without closing or recreating the stream. They must never leave
  the overlay stuck in `targetLocked`/`fullscreen`.
- `resource.remote_window_touch_action` owns gesture classification. At zoomed
  fullscreen scale, one finger is a complete no-op: it emits no remote input,
  does not change local pan, and cannot trigger tap, hold, drag, or double-tap.
  Zoomed floating keeps the existing local-pan projection.
  Two-finger coherent same-direction motion is remote scroll, not local window
  pan. When a second finger upgrades an active one-finger local pan, the pair
  owner takes over immediately; the first pair sample must be classified and
  must not be consumed by the observation window.
- At 1x, a stationary tap remains one remote `click` business event. The
  daemon-owned `resource.remote_window_stream` performs the exact
  `CGWindowID` focus/raise check inline before injecting that click; the client
  must not replace the click with a local visual-only focus change.
- No second gesture channel, fallback input path, or daemon-side client state
  may be introduced for these fixes. The shared wire event remains the single
  input contract.

The stream is not view-only long term. It must support mouse and keyboard event return. Input return must carry an explicit focus policy:

- `bring-to-focus`: the daemon brings the selected app/window/pane to focus before forwarding OS input.
- `no-focus-steal`: the daemon must not claim generic OS mouse/keyboard success for normal apps. Terminal-specific routes may still use iTerm2 API or tmux input if declared.

Generic app OS input requires macOS Accessibility permission. App activation alone is not enough for covered or background windows, including apps such as WeChat. The daemon input config must carry the target window id/title/bounds, match the Accessibility window by exact `CGWindowID` identity, check the current frontmost PID, activate the owning app only when the target is not already frontmost/focused, `AXRaise` the matched window, set it as focused/main when supported, verify that the app is frontmost and the exact target window is focused, and only then post Quartz events. Client-sent `focus` remains a compatibility/explicit bring-front intent, but it is not the required queue item before every real operation; real click, pointer, scroll, key, QuickBar, and IME actions leave Android as one business action and perform the same daemon-owned frontmost/focused check inline before injection. Stream start, video attach, fullscreen entry, IME lift, picker/catalog refresh, pinch zoom, zoomed one-finger local suppression setup, close, and screenshot must not focus the desktop app. Event coordinates use the daemon manifest/`CGWindowList` top-left coordinate space directly. Android IME committed text is sent without terminal punctuation/newline normalization. Android/DOM scroll deltas use positive values for down/right, while macOS `CGEvent` pixel wheel values use the opposite sign; the daemon input owner performs that conversion exactly once. The client input-delivery owner keeps reliable sequence/retry/ACK control separate from actions, coalesces continuous scroll/move, and flushes before reliable barriers. The daemon input-delivery owner preserves each continuous action's original receive time, drops only over-age continuous work, deduplicates reliable sequence, and never applies continuous stale policy to release/key/click/barrier records. The macOS helper lifecycle remains one ready-checked persistent Swift helper, including daemon-only legacy gesture decoding for old clients; no event compiles a fresh `swift -e` process. The Swift decode schema matches the wire union: focus/scroll/click omit `phase`, legacy gesture carries `phase=end`, and pointer/key require `phase`.

## Resource Boundary

Two resources are introduced:

- `resource.remote_window_overlay`: Android picker/floating/fullscreen projection and user intent.
- `resource.remote_window_stream`: daemon/native catalog, coordinate manifest, capture, encoder/WebRTC sender, target lease, and input injection truth.

`resource.remote_window_overlay` may project UI state, fullscreen zoom/pan state, and stream/input intents. It must not compute macOS coordinates, read iTerm2 split trees, or inject remote input.

`resource.remote_window_stream` owns desktop facts on the daemon host:

- app/window catalog
- iTerm2 tab/pane catalog
- iTerm2 pane relative coordinates
- tmux reverse lookup from iTerm2 session `tty`
- coordinate normalization
- ScreenCaptureKit/window capture
- crop-to-pane transform
- WebRTC sender lifecycle
- remote input target lease
- explicit error projection

Terminal buffer resources (`resource.mirror_store`, `resource.client_sparse_buffer`, `resource.renderer_window`) are not stream truth and must not be used as a video fallback.

## Target Manifest

The daemon must return a typed manifest before stream start:

```ts
type RemoteWindowStreamTargetManifest = {
  streamTargetId: string;
  videoTarget: {
    kind: "app-window" | "iterm2-pane";
    appBundleId: string;
    pid: number;
    windowId: string;
    title: string;
    windowBoundsTopLeftPx: { x: number; y: number; width: number; height: number };
    paneRectInContentPx?: { x: number; y: number; width: number; height: number };
    contentTopInsetPx?: number;
  };
  inputTarget: {
    kind: "app-window" | "iterm2-pane" | "tmux-pane";
    itermSessionId?: string;
    tty?: string;
    tmuxSession?: string;
    tmuxWindowId?: string;
    tmuxPaneId?: string;
  };
  streamMode: "view" | "interactive";
  focusPolicy: "bring-to-focus" | "no-focus-steal";
  inputRoute: "os-event" | "iterm2-api" | "tmux-input";
  capture: {
    source: "ScreenCaptureKit";
    coordinateSpace: "macos-top-left-px";
    displayId?: string;
    scale: number;
    createdAt: string;
  };
};
```

`app-window` targets are not limited to iTerm2. They come from daemon-side macOS app/window catalog truth and use generic OS input policy (`focusPolicy="bring-to-focus"`, `inputRoute="os-event"`). iTerm2 pane targets are additional child targets when the iTerm2 API is available. Android picker projection keeps iTerm2 panes collapsed by default; expanding the group is an explicit user action and does not change daemon catalog truth.

## iTerm2 Coordinate Rule

The verified coordinate model is:

```text
window top-left frame: macOS Accessibility / System Events
iTerm2 pane frame: iTerm2 Python API split tree, flattened to content top-left coordinates
contentTopInset = windowHeight - max(pane.y + pane.height)
cropRect = {
  x: window.x + pane.x,
  y: window.y + contentTopInset + pane.y,
  width: pane.width,
  height: pane.height
}
```

Mac Studio live proof on 2026-07-19 used a temporary two-pane iTerm2 tab with red/blue marker rows. The direct top-left formula above hit the expected pane colors, while an inverted-y formula hit zero expected samples. Do not invert `pane.y` after the pane tree has been flattened to content coordinates.

iTerm2 session frames can be local to their immediate splitter. For nested split layouts, the daemon must flatten splitter child offsets first, then apply the formula once. The daemon must normalize this once and return the normalized manifest. Android must not repeat this conversion.

tmux reverse lookup:

```text
iTerm2 session id -> iTerm2 session tty -> tmux list-clients client_tty -> tmux session/window/pane
```

tmux metadata is enrichment only. An iTerm2 pane with no matching `tmux list-clients` entry must still be returned as an explicit `iterm2-pane` target with `inputRoute="iterm2-api"` and no fake tmux identifiers. Until the daemon has a verified `tmux-input` / `iterm2-api` input route, Android must project those pane targets as read-only for input and must not publish a remote-window input context or send pointer/scroll/gesture/key events for them.

## State Machine

```text
idle
  -> pickerOpen
  -> targetEnumerating
  -> targetLocked
  -> floatingStream
  -> fullscreenStream
  -> floatingStream
  -> closed
```

Only `closed` releases capture, encoder, WebRTC sender, and target lease. Back from `fullscreenStream` must not close or recreate the stream.

The user-visible session stage is a separate chain from the overlay phase: `idle -> resolving-route -> signaling -> negotiating-media -> awaiting-first-data -> awaiting-first-frame -> streaming`, with `reconnecting` and `error` as exits. The two post-connect stages exist because a connected transport is not a visible picture. `awaiting-first-data` means the receiver attached and the wire may carry data; `awaiting-first-frame` means the daemon confirmed its capture started; `streaming` means a decoded frame actually reached the client surface. Each transition is driven by its own real event — receiver attach, the daemon's `capture-started` status, and the first decoded frame — and a transition carrying another stream id is ignored. No UI timer may advance either post-connect stage, because a clock cannot tell "the Mac is sending" from "the phone is decoding".

Floating preview geometry and fullscreen zoom state are Android projection-only. The floating preview uses the selected manifest crop/window aspect ratio instead of a fixed frame. Fullscreen local drawing/input stays aspect-fit; the fill action is an explicit daemon `window-resize` request only for ordinary app-window targets. iTerm2 app-window and pane targets must reject that request so streaming cannot resize the iTerm window or tmux shell; the behavior must not be faked by local cover/crop, tmux resize, capture restart, WebRTC renegotiation, or coordinate fallback. Pinch zoom may enlarge above fit and shrink back to 1x, but the client must not render a minimap/viewport overlay or allow shrinking below fit. Pointer/keyboard events emitted from the video surface are normalized against the selected manifest crop and sent as explicit input intents; the media `<video>` is pointer-transparent and daemon/native input policy is still the only injection truth. In the embedded half-sheet preview the video surface is non-interactive: it renders the received frame only, and the drawer grip owns the transition to embedded fullscreen.

Remote-window media negotiation is a separate WebRTC peer connection, but its ICE configuration must be derived from the current session traversal route. When the active session resolved through `rtc-direct`, the video receiver/start request uses the same STUN-only direct ICE truth. When it resolved through `rtc-relay`, the video receiver/start request uses the Relay TURN ICE truth. Android must not leave the remote-window video peer connection as no-ICE on Relay/cellular paths, and must not invent a screenshot or terminal-buffer fallback if ICE/media negotiation fails.

Video quality is stream-local control, not transport lifecycle. `smooth` is the default preference and `quality` is selectable. One typed profile contains maximum bitrate, capture dimensions, frame rate, maximum frame age, interaction state, and overview budget. The client quality owner keeps `appliedProfile`, `desiredProfile`, one in-flight revision, one queued latest profile, and a two-sample post-apply cooldown. Network, host capture/encode, Android decode/render, and latency-only facts remain separate; degradation moves one level after two matching samples unless pressure is severe, and recovery moves one level after a 12-second stable window. Bitrate-only changes preserve and mutate existing sender encodings without touching capture; cadence/dimension/filter changes update the existing `SCStream` configuration/content filter; exact matches return applied no-op. No quality change may stop/recreate capture, receiver, peer, transport, or layout. Empty sender encodings during start mean quality is explicitly not applied while video startup continues; the same condition during a live update is an explicit unsupported quality error. Unsupported or inconsistent profiles are rejected explicitly.

The remote-window app catalog is daemon-owned resident truth, not tmux-session data and not client cache. The daemon catalog runtime warms one canonical full app-window+iTerm2 snapshot, keeps it current with its own refresh loop, and a client read is a read-time projection of that snapshot: it filters by the requested source set and rewrites the top-level and nested error `requestId` to the current caller. Opening the picker or switching sessions never triggers live Swift/iTerm2 enumeration, and the client keeps no projection cache that could mask a newer daemon refresh. Every picker open, selection admission, and active-stream entry re-reads the daemon snapshot over the existing `SessionContext` transport, which keeps the client projection equal to daemon truth at the moment it is read. Android background service reentry may briefly report the same session's mux channel as `closed` before its bounded reopen; catalog readiness may wait for that same session channel to reopen, but it must not reuse a stale closed-channel physical socket or hide a timeout behind a previous snapshot. This does not create a second WebSocket and does not replace the existing `SessionContext` transport owner.

Image paste follows the current focus owner. When the active focus owner is a remote-window stream, Android sends the normal paste-image upload with `pasteTarget.kind=remote-window`; the daemon writes the macOS clipboard and injects Command+V through the remote-window input owner for that stream/target. When terminal surface focus is activated, Android clears the remote-window input context and the same QuickBar image action remains on the terminal paste path, writing the macOS clipboard and sending the terminal Ctrl+V sequence. The daemon must not guess focus from the desktop window list or app title.

## Explicit Errors

The daemon must fail explicitly for:

- Screen Recording permission missing
- installed daemon capture capability missing (`remote_window_capture_binary_missing`)
- Accessibility permission missing
- iTerm2 API unavailable
- app/window not found
- iTerm2 pane not found
- tmux reverse lookup missing
- target rectangle outside window/content bounds
- window minimized or not drawable
- ScreenCaptureKit capture start failure
- WebRTC sender failure
- input return rejected by focus policy

No fallback may silently downgrade this feature to screenshot, terminal buffer render, stale cached image, another TCC subject, or a runtime-generated capture process. Install-time permission probing and ScreenCaptureKit startup both use the one installed `zterm-daemon` binary: `--permission-probe` before service bootstrap, and the `remote-window-capture` subcommand as the runtime child.

The install-time probe must REQUEST Screen Recording permission instead of only asking whether it is already granted. When `CGPreflightScreenCaptureAccess()` reports no permission, the probe calls `CGRequestScreenCaptureAccess()` exactly once, then waits for the human answer by polling `CGPreflightScreenCaptureAccess()` under one bounded deadline, and exits 0 on grant or 5 when the deadline passes. The request is never repeated, no TCC state is reset, and no second executable is used.

macOS 26 may refuse to show that dialog. Measured on the Air (macOS 26.6.2, 2026-10-16): `tccd` answered every request within 2 ms with `Service kTCCServiceScreenCapture does not allow prompting; returning denied.` This happened for an ad-hoc bare binary launched by launchd, for an ad-hoc bundle launched through LaunchServices, and for a bundle signed with a stable local certificate; the screen was unlocked for the last two. The subject was attributed correctly in all three cases (`responsiblePath` was the installed `zterm-daemon`), so this is the platform prompting policy, not an attribution error. The install step therefore must not treat the request as its only recovery path. When the probe exits 5, the install output must name the exact installed binary path and the exact System Settings pane and add button, and must not claim that a dialog was shown. A notarized Developer ID build may restore the prompt; that is unverified here.

The runtime capture child stays preflight-only. It calls `CGPreflightScreenCaptureAccess()` once and exits 5 before capture allocation when permission is missing, because the grant decision belongs to the install step and a running stream must not block on a dialog. The daemon never initiates a grant from a stream request, and a missing permission is an explicit typed failure, not a retryable condition.

Two silent states must stay distinguishable. A capture child that exits 5 states a permission denial. A capture child that built its SCStream but delivered no frame within the startup timeout is different: macOS shows no dialog and the child prints no stderr, so the failure looks like a generic timeout. The startup timeout error must therefore carry the child's collected stderr even while the child is still alive, and it must name the missing-permission case separately from a generic timeout. The focus capture lane reports that zero-frame case as `failureStage: focus-capture-first-frame`; any other capture-start rejection keeps `focus-capture-start`.

## Implementation Status

## 2026-09-11 Projection and gesture correction

The Android projection must preserve the selected remote frame's intrinsic aspect
ratio in both floating and fullscreen modes. The locked video surface is the
device container; its content uses aspect-fit with equal horizontal and vertical
centering. Local CSS `cover`, stretch, or edge alignment is not a valid way to
match the remote display. A fullscreen `window-resize` request remains an
independent daemon control intent for resizable ordinary app windows; it does
not change the local projection rule and must never resize iTerm2 panes or shell
geometry.

Gesture classification is independent from media quality and latency policy.
At 1x, one-finger touch emits the existing remote scroll/tap actions. After
local pinch or double-tap zoom, zoomed fullscreen one finger is a complete
no-op: it emits no remote input and does not move the local projection.
Zoomed floating keeps local canvas pan. Two-finger same-direction motion emits
remote scroll; two-finger pinch remains local zoom.
No gesture branch may wait for, or reinterpret itself from, GOP, frame queue,
bitrate, or ACK timing.

Media latency work is a separate pipeline concern. Capture, send, receive,
decode, present, input, and ACK timestamps must remain separately observable.
Any GOP/keyframe tuning must use a verified sender/runtime capability and must
not be faked by increasing queues, suppressing input, lowering FPS blindly, or
changing gesture semantics.

RustDesk's current server path is a reference for this work: its live stream
encoder leaves `keyframe_interval` unset (the explicit interval is reserved for
recording), uses a bounded `VideoFrameController`, and adapts from measured
delay / blocked-send evidence before changing FPS or bitrate. Our current
`@roamhq/wrtc` `RTCVideoSource`/`RTCRtpSender` surface exposes no verified GOP or
keyframe interval control, so this slice records the capability gap instead of
adding an unrecognized wire field or pretending the profile already controls
GOP.

Current status is anchored for app-window catalog, collapsed same-app picker rows plus active video-layer primary-plus-children sibling window switching inside the same locked video container, portrait child rail above the primary video and landscape child rail beside it, default-collapsed iTerm2 picker grouping, real ScreenCaptureKit/WebRTC video, Android floating/fullscreen projection with safe-area top chrome and TerminalPage-measured QuickBar + IME bottom-inset lift for the whole locked container, toolbar-reachable floating resize, fullscreen aspect-fit drawing plus ordinary app-window-only remote target resize fill, iTerm2 geometry protection, zoom/pinch without any minimap overlay, route-derived ICE for remote-window video, smooth/quality stream profiles, focus-aware image paste routing, raw Android IME text routing, 1x one-finger realtime remote scroll, zoomed one-finger local suppression, zoomed two-finger realtime remote scroll, 250 ms reliable hold-drag, 500 ms right click, local pinch, reliable cancel release, Mouse Emulation pointer/wheel input, read-only projection for unsupported iTerm pane input routes, generic `bring-to-focus + AXRaise + os-event` click/pointer/scroll/key injection, decoded-frame-driven canvas projection, bounded per-lane latest capture conversion, and remote-window screenshot requests that reuse the existing remote screenshot/file-download path without focus. Remaining live completion gaps are installed-daemon and Android real-device A/B, active-route input/frame-age/cleanup proof, and iTerm2-pane stream/input proof.
Current status is also anchored for foreground/background power safety: backgrounded app state is a close/stop signal for any active remote-window stream and must not leave the receiver or capture pipeline running offscreen.

## 2026-08-19 Layout, Quality, and Gesture Boundary Lock

The daemon is the only canvas-layout truth owner. Every started/status projection publishes one typed `RemoteWindowCanvasLayoutV1` with a monotonically increasing `generation`, canvas bounds, focus rectangle, and overview rectangle. Android may scale those published rectangles into the local video element, but it must not rebuild composite geometry from target manifests. Composite coordinate input carries the currently rendered `layoutGeneration`; the daemon rejects missing or stale generations before OS input injection. Layout-independent key, text, and paste operations do not require a generation.

Remote SDP is applied exactly once. The daemon must not rewrite client SDP, synthesize a local offer, or retry negotiation through a second semantic path. Invalid SDP produces an explicit typed start error and closes the peer.

For protocol v2, `mediaBindings` declares the sender lanes and their sender-local
track/stream identities. Android must bind each `RTCTrackEvent` to the
`RTCRtpTransceiver` returned when the media-plan lane was added (`focus`, then
`overview`), because WebRTC track and stream IDs are endpoint-local and the
negotiated `mid` is an opaque string rather than a lane index. An event without a
registered transceiver is resolved against the peer's negotiated transceiver list,
with a decimal m-line index retained only as a compatibility readback when that
list does not expose mids. A duplicate lane attachment remains an explicit
receiver error; no first-track fallback is permitted.

Validation evidence for the current remote-stream candidate (2026-09-10):

- `pnpm exec vitest run src/lib/remote-window-receiver-runtime.test.ts src/lib/remote-window-overlay-runtime.test.ts src/server/remote-window-input-policy.test.ts src/lib/remote-window-boundary-truth.test.ts --reporter dot`: 4 files, 47 tests passed.
- `pnpm exec vitest run src/components/terminal/RemoteWindowOverlay.test.tsx -t 'requests a unified 1080p short-edge remote window resize on entry and on fill|never resizes an iTerm2 target when entering fullscreen fill' --reporter dot`: 2 tests passed.
- `pnpm run test:remote-window-webrtc-loopback`: `ok=true`; single-focus received 7 focus frames, overview-plus-focus received 8 focus and 7 overview frames, ICE order preserved; `senderParameterResults=unsupported/InvalidStateError` is the known wrtc quality limitation.
- 15T (`PLZ110`, ADB `100.104.163.65:5555`) with APK `0.1.3.2928` / SHA-256 `beaa329a04e51d412429d6289b97729d9fce5e999cf5cbd852e35205d657f030`: iTerm2 `tmux %12` video `603x939`, `readyState=4`, `srcObject=true`, decoded `currentTime` advanced `0.086205 -> 5.813783`; `zterm-3` stayed `84x52` before and after, and no resize request was issued.

Live quality control is an acknowledged stream-group profile transaction. A request carries `streamGroupId` and monotonic `revision`; success returns the requested and actually applied focus/overview configuration plus the one total group budget. Bitrate-only updates mutate sender parameters only; cadence/dimensions update the existing capture configuration in place; exact matches are no-op. Any lane failure rolls every touched lane back, does not advance the applied revision, and returns an explicit rejection. The client displays desired/in-flight/applied/rejected separately, queues only the latest desired profile, never projects requested quality as applied before the matching ACK, and ignores the next two transient stats samples. Cause-specific ABR uses a bounded one-level ladder and restores only one level after a stable window.

Gesture recognition has one client owner. Direct Touch one-finger movement commits to realtime remote scroll at 1x unless the 250 ms hold has committed reliable drag; zoomed floating keeps local canvas pan and zoomed fullscreen one finger is a complete no-op. A stationary 500 ms hold emits one right click at 1x. Two-finger coherent motion commits to remote scroll at both 1x and zoomed scale, and anti-parallel distance change commits to local pinch. Modes latch until the sequence ends; duration never invalidates release and cancel releases any remote down. Mouse Emulation drag emits pointer down, realtime move, and pointer up. The first direct-touch scroll event sets `moveCursor=false`. Runtime dispatch consumes the recognized business action; sequence/retry/ACK remains in the separate delivery control owner and no second long-press recognizer exists. Primary controls expose mode, screenshot, keyboard, and More with 48-by-48 minimum hit targets; low-frequency display and quality controls live under More, and developer diagnostics remain collapsed separately from user status.

## 2026-10-17 Latency and clarity tuning points

This is the §3.2 inventory for the remote-window perf task. Each row is a point where a measured segment can actually be changed, with its current owner. No row is a claim of a measured gain; measurement remains the released-gate evidence.

| point | current value and owner | segment it moves |
| --- | --- | --- |
| capture pixel format | `src/server/remote-window-screen-capture-script.ts:105` fixes `kCVPixelFormatType_32BGRA` and converts through `rgbaToI420` (4:2:0) | chroma clarity (B-1), VBR size |
| capture frame rate | same file `:107` sets `minimumFrameInterval = 1/frameRate`; the value originates from the client profile `frameRate` (`src/lib/remote-window-video-quality.ts:904`) and reaches the daemon at `src/server/remote-window-stream-daemon.ts:1454` | capture fps, encode load |
| capture output size | same file `:112-115` uses `outputWidth`/`outputHeight` from the layout planner, else the crop rect | clarity under zoom (B-2), encode cost |
| bitrate bounds | `src/lib/remote-window-video-quality.ts:169-175`: `smooth` 750k-4M, `quality` 3M-10M | text legibility, send pressure |
| quality multiplier | `src/lib/remote-window-video-quality.ts:14` persists a multiplier under `zterm:remote-window:quality-bitrate-multiplier-v1` | applied budget (client policy only) |
| ABR ladder | `src/lib/remote-window-video-quality.ts` bounded one-level ladder, restore one level after a stable window | recovery shape after pressure |
| codec | VP8 only; no 4:4:4 profile exists in the current sender, so B-1 must change the conversion path before any chroma claim | chroma clarity (B-1) |
| input injection | daemon `daemonInputInjectMs` telemetry (p50 2 ms when the host is idle, 28 ms under load) | input-to-frame latency |
| client presentation | `requestVideoFrameCallback` plus 2D canvas `drawImage`; `clientPresentedFrameIntervalMs` is the observed interval | perceived smoothness |
| route and RTT | `TraversalDiagnostics` (resolved path, ICE round trip) is produced in `src/lib/traversal/socket.ts:765` and has no client projection yet | A-2 status line and verdicts |

Two rules follow from this table. First, no point may be changed without a baseline run recorded under the harness comparability conditions, because host load alone moved `daemonEncodeMsPerFrame` from 1.13 ms to 58 ms across runs. Second, network delay and frame delay stay separate in every report; they are different segments and must never be added into one number.

### Cursor capture state (§3.3)

The two screenshot paths explicitly exclude the pointer: `scripts/native/zterm-daemon.swift:76` and `:105` both set `configuration.showsCursor = false` before `SCScreenshotManager.captureImage`. The streaming path does not. `src/server/remote-window-screen-capture-script.ts:102-116` builds its own `SCStreamConfiguration`, sets pixel format, frame interval, and output size, and never assigns `showsCursor`, so it keeps the platform default of true. That stream uses a window-scoped filter, `SCContentFilter(display:including:[window])` at `:367` and `:423`.

The honest conclusion is therefore conditional, not absolute: the streaming lane has no explicit cursor opt-out, and the screenshot lane does. Before C-4 draws a client-side cursor, a device run must confirm whether a window-scoped filter already renders the pointer; if it does, an explicit `showsCursor = false` belongs in the stream configuration, not in the client.

### §3.1 Baseline table

Reproduce with `node scripts/remote-window-perf-baseline.mjs --serial <serial> --cdp-port <port> --seconds 30 --out <dir>`. It drives the installed app through the real remote-window entry, takes daemon telemetry from the authenticated channel, and writes one table plus a `baseline.json`. Every value is a labelled proxy segment; none of them is glass-to-glass latency. `host: load` is the machine that runs the harness; the daemon segments come from whichever daemon served the run, so the daemon uptime and target window identify the run.

Three runs against the Air daemon with the same build and a 580x385 window, all inside one hour:

| run (UTC) | host load | capture to encode p50 | encode p50 | packet send p50 | network RTT p50 | captured fps | input inject p50 | decoded growth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-16T02-03-44Z | 42.72 / 43.02 / 43.86 | 1 ms | 1.13 ms | 2.92 ms | 341 ms | 28.5 | 2 ms | 15 -> 510 |
| 2026-10-16T02-11-02Z | 49.31 / 45.49 / 44.79 | 1 ms | 1.09 ms | 1.53 ms | 339 ms | 28.55 | 3 ms | 3 -> 987 |
| 2026-10-16T02-16-13Z | 48.69 / 48.14 / 46.43 | 1 ms | 1.14 ms | 2.89 ms | 338 ms | 28.49 | 2 ms | 6 -> 1117 |

Two runs on a saturated host, same app and same harness, for the negative envelope:

| run (UTC) | host load | capture to encode p50 | encode p50 | packet send p50 | network RTT p50 | captured fps | input inject p50 | decoded growth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-15T05-14-45Z | 65.49 / 64.45 / 62.78 | 18 ms | 65.75 ms | 265.86 ms | 15 ms | 2.9 | 37 ms | 1 -> 39 |
| 2026-10-16T02-54-17Z | 56.06 / 53.5 / 50.26 | 32 ms | 58.15 ms | 68.86 ms | 22 ms | 3.58 | 28 ms | 3 -> 88 |

Reading rules for every later comparison:

- The `daemonNetworkRttMs` near 340 ms in the Air rows is a tunnel-topology artefact, not a LAN round trip. Compare it only against runs with the same topology.
- `droppedVideoFrames` exceeded decoded frames in the Air rows because the receiver draws into a hidden `opacity: 0` video surface on a software rasterizer. It is not a stream defect and must not be quoted as one.
- A run is comparable only when the host load is low and the target window, resolution, and topology match. A saturated host changed encode p50 by more than 50x, so no timing claim may be made from the negative rows.
- The baseline shows the three-track priorities in order: capture-to-encode and encode are already 1 ms on an idle host, while packet send delay and the client-side ack round trip are the segments with room, and clarity is limited by the 4:2:0 conversion rather than by the encoder.

### 3.4 Capture resolution must follow content dynamism, not window size

Measured on the Air daemon through the node stream probe (`android/scripts/remote-window-node-stream-probe.mjs`), one variable changed per row (`videoProfile.maxCaptureWidth/Height`):

| target content | maxCapture | actual output | client fps | bitrate | encode ms/frame | send ms |
| --- | --- | --- | --- | --- | --- | --- |
| static window (723x853 native) | 640x400 | 339x400 | 28.2 | 20.0 kbps | 0.89 | 0.62 |
| static window | 1280x800 | 678x800 | 28.0 | 63.3 kbps | 1.25 | 1.12 |
| static window | 1920x1200 | 723x853 | 27.7 | 70.2 kbps | 1.22 | 1.01 |
| scrolling terminal | 640x400 | 640x314 | 27.1 | 52.7 kbps | 1.34 | 1.11 |
| scrolling terminal | 1280x800 | 1280x628 | 20.5 | 142.8 kbps | 1.39 | 24.1 (startup) |
| scrolling terminal | 1920x1200 | 1920x942 | 21.9 | 176.5 kbps | 3.45 | 16.4 (startup) |

Rules that follow from the table:

- The capture ladder itself works. Output follows `maxCapture*` and saturates at the native window size, so a zoom-aware raise is not silently clamped.
- On static content, raising the cap is almost free: encode moves 0.89 to 1.25 ms and frame rate does not change.
- On moving content, raising the cap costs frame rate: 27.1 fps at 640 wide falls to 20.5 at 1280 wide, and encode cost triples at 1920 wide. The cap must therefore be chosen from content dynamism, not from window size alone.
- Bitrate is not the limiting factor for clarity here. Scrolling text stays under 180 kbps, so the clarity ceiling lives in chroma subsampling and scaling, not in the bitrate budget.
- The 16 to 24 ms packet send values are connection-startup transients. Steady state is 1.5 to 2.6 ms and does not respond to `maxBitrateBps` (measured 500 kbps versus 2 Mbps at the same 1280x800 target, both around 67 kbps actual). Do not read a startup sample as a steady-state bottleneck.
