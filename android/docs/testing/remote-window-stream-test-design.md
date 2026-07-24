# Remote Window Stream Test Design

## Scope

Feature id: `desktop.remote_window_stream`

This gate covers remote app/window and iTerm2 pane video streaming from a daemon host to Android, plus the future input-return contract. The stream is a desktop media resource, not terminal buffer truth.

## Current Implementation Status

The implemented Android/catalog slice started narrower than feature completion:

1. `TerminalPage` renders the remote-window floating entry and passes only the active session id plus the SessionContext catalog request callback.
2. The picker requests the daemon `RemoteWindowStreamTargetManifest[]` catalog, renders app-window rows directly, keeps iTerm2 pane rows collapsed behind an explicit group until expansion, and surfaces explicit partial/top-level errors.
3. Selecting one manifest locks a floating overlay shell to that target; the floating video surface sizes from the selected manifest crop aspect ratio before stream start and from daemon `started.capture.frameWidth/frameHeight` after stream start, toolbar drag repositions only the floating projection, resize keeps the toolbar reachable, the explicit fullscreen button or double tap/double click on the video surface enters fullscreen, Back/minimize returns to floating, and close invalidates the UI state. Fullscreen defaults to aspect-fit complete display and exposes an explicit aspect-fill option that covers the current portrait or landscape phone surface without changing daemon capture geometry.
4. While the picker is open, `TerminalPage` suppresses the terminal quickbar/input shell and asks the existing IME owner to hide the system keyboard. Once a remote-window stream is target-locked, floating and fullscreen modes keep the QuickBar available above the overlay; opening the Android IME lifts the floating preview by the reported bottom inset. QuickBar keyboard/text/paste/arrow actions and Android IME committed text/backspace/key events route to `remote-window-input` only for supported app-window OS-event targets; current `tmux-input` / `iterm2-api` routes are projected as read-only and must not publish an input context or send unsupported events.
5. Before stream start the shell displays an honest setup/waiting state. It does not claim that capture started and does not use terminal mirror, sparse buffer, renderer rows, screenshot runtime, or any synthetic frame source as video.

The current real-video implementation slice now additionally binds:

1. `remote-window-stream-start-request` / ICE / status / stop protocol over the existing active session transport.
2. Android `createRemoteWindowReceiverRuntime()` WebRTC recvonly setup and `<video data-testid="remote-window-video">` receiver surface.
3. Daemon `startStream()` / `addIceCandidate()` / `stopStream()` lifecycle in `src/server/remote-window-stream-daemon.ts`.
4. Daemon `startScreenCaptureKitFrameSource()` real macOS ScreenCaptureKit process source, RGBA-to-I420 conversion, `RTCVideoSource` feeding, and exactly-once cleanup.
5. Mac local live proof for a generic app-window marker: temporary native AppKit window -> catalog target -> ScreenCaptureKit capture -> WebRTC receiver -> pixel oracle. This does not replace the required Android rendered-pixel gate.
6. Android overlay maps video-surface pointer/key/scroll events to `remote-window-input` intents. Unzoomed touch tap emits pointer down/up; unzoomed touch drag emits no raw move stream and emits one focus-first `gesture/swipe` action at release with start/end coordinates, delta, duration, and velocity; mouse/trackpad wheel input remains pixel scroll, and zoomed fullscreen drag remains local pan. The daemon implements generic `bring-to-focus + os-event` pointer/scroll/gesture/key injection for active streams. Floating/fullscreen screenshot is a separate remote-screenshot/file-download request carrying the selected target manifest; it is not input and must not emit focus.
7. Remote-window QuickBar input is projection-only: terminal/tmux/iTerm-specific actions such as tmux copy are disabled/grey while generic key, text, paste, arrows, image paste, and keyboard invocation remain available. Android IME committed text and native key/backspace events route to the active remote-window stream while the context is active. QuickBar image paste uses `pasteTarget.kind=remote-window` only while the active focus context is the remote window; terminal surface focus clears that context and returns the same image action to the terminal Ctrl+V paste path.
8. Video bitrate is stream-local quality control: stream start carries the effective selected bitrate config, floating preview starts low at `2mbps`, untouched defaults derive from selected desktop window area divided by daemon-provided display area, Android phone fullscreen does not upgrade bitrate by itself, the overlay selector sends `remote-window-stream-quality-request` for an active stream, and the daemon may update only the existing WebRTC sender encoding entries without changing the `encodings` array structure. Effective quality may be capped by measured browser network hints and WebRTC `getStats()` samples; regular presets default to 30 FPS, desktop-fullscreen preset caps at 60 FPS, stream start passes that requested max FPS into ScreenCaptureKit, weak stats require consecutive weak samples before downgrade to one-quarter bitrate and half FPS, and restore happens only after a stable window using per-sample deltas for cumulative dropped/freeze/jitter counters. An empty sender `encodings` array must not fail stream startup or produce a false `capture.maxBitrateBps`; a later live quality update against the same unsupported sender must fail explicitly. The update must not restart capture or rebuild transport.

Still pending for feature completion:

1. Android real-device rendered-pixel proof through the installed WebView receiver.
2. Live iTerm2-pane stream pixel proof through the same ScreenCaptureKit/WebRTC path.
3. iTerm2/tmux-specific input-return proof.
4. APK build/publish for this interaction slice after focused, architecture, type, and local daemon gates pass.

Current executable gates:

- `src/lib/remote-window-message-runtime.test.ts`
- `src/lib/remote-window-overlay-runtime.test.ts`
- `src/lib/remote-window-touch-action-runtime.test.ts`
- `src/components/terminal/RemoteWindowOverlay.test.tsx`
- `src/lib/remote-window-receiver-runtime.test.ts`
- `src/pages/TerminalPage.remote-window-overlay.test.tsx`
- `src/contexts/session-context-remote-window-runtime.test.ts`
- `src/contexts/session-context-socket-message-runtime.test.ts`
- `src/server/remote-window-stream-daemon.test.ts`
- `src/server/terminal-message-runtime.test.ts`
- `src/lib/remote-window-input-mapping.test.ts`
- `src/lib/remote-window-video-quality.test.ts`

## White-Box Gates

1. Resource/function/mainline gates
   - `src/lib/resource-registry-truth.test.ts`
   - `src/lib/function-map-resource-truth.test.ts`
   - `src/lib/mainline-resource-call-map.test.ts`
   - `src/lib/function-wiki-truth.test.ts`
   - `src/lib/feature-registry-truth.test.ts`

2. Coordinate normalization
   - Enumerate generic macOS app windows through daemon-side window catalog truth and produce `app-window` manifests.
   - Convert macOS window frame and flattened iTerm2 pane frames into one top-left pixel coordinate space.
   - Red-test inverted-y math after split-tree flattening; `pane.y` must not be inverted again once it is content top-left.
   - Cover Retina scale, multi-display origin, title/tab/content inset, pane split divider, and rect-out-of-bounds rejection.

3. iTerm2 split tree flatten
   - Flatten nested vertical/horizontal split tree into leaf pane rectangles.
   - Preserve session id, tab id, tty, grid size, and title metadata.
   - Reject missing or ambiguous pane targets.

4. tmux reverse lookup
   - Map `iTerm2 session tty` to `tmux list-clients #{client_tty}`.
   - Return tmux session/window/pane ids when present.
   - Preserve non-tmux iTerm2 panes as explicit `iterm2-pane` targets without fake tmux ids.
   - Non-tmux panes must remain selectable; tmux metadata is enrichment, not a selection precondition.

5. Multi-source catalog errors
   - If generic app-window enumeration succeeds and iTerm2 API fails, return selectable app-window targets with an explicit iTerm2 catalog error.
   - If a requested catalog source fully fails and no targets remain, return a top-level explicit error.
   - Do not silently hide source errors as a fallback success.

6. Overlay state machine
   - Current minimal slice: `targetLocked/fullscreen + Back -> targetLocked/floating`
   - Current minimal slice: `targetLocked/fullscreen + minimize -> targetLocked/floating`
   - Current minimal slice: late catalog responses from an older request epoch cannot overwrite the current picker/closed state.
   - Current minimal slice: a catalog request that never settles must leave loading and show an explicit UI timeout within the bounded watchdog window; the picker cannot remain indefinitely at `读取中`.
   - Current minimal slice: `close -> closed`, with no frame source fabricated.
   - Current slice: `pickerOpen/fullscreen` reports shell suppression to `TerminalPage`; floating video reports suppression false so QuickBar returns while the stream remains open.
   - Current slice: `pickerOpen` suppresses QuickBar; target-locked fullscreen still suppresses terminal body subscription but keeps QuickBar visible above the overlay for remote-window input.
   - Current minimal slice: toolbar pointer drag captures the pointer, updates the floating projection from toolbar-local pointer moves as well as window moves, releases capture on end/cancel, remains bounded to the viewport, and is disabled in fullscreen; video/input surface gestures remain separate.
   - Current slice: the floating preview shell derives its initial video aspect ratio from the selected `windowBoundsTopLeftPx` / `cropRectTopLeftPx`, not from a fixed 16:10 preview frame; after `remote-window-stream-started`, the receiver projection uses daemon `capture.frameWidth/frameHeight` as the display aspect while preserving manifest crop coordinates for input.
   - Current slice: a floating preview can be resized from its bottom-left and bottom-right corners; the resized video surface keeps the selected source aspect ratio, left/right anchoring follows the grabbed corner, resize caps growth before the toolbar crosses the top viewport margin, and the overlay remains movable through the toolbar after resizing.
   - Current slice: a target-locked floating preview consumes `bottomInsetPx`; an IME inset of `320` lifts the preview from its `118` base to `438px`. Fullscreen remains governed by safe-area layout instead of this floating offset.
   - Current slice: target-locked fullscreen consumes `bottomInsetPx` as overlay padding, not page layout height. While the keyboard is open, `bottomChromeInsetPx` auto-pans the local projection upward by the measured QuickBar chrome so the initial state is not covered. Unzoomed one-finger fullscreen drag still belongs to the remote app and emits one release-time gesture action; only zoomed fullscreen (`scale > 1`) one-finger drag pans the local projection. Exact-fill surfaces must keep the projection stable at scale one and must not use the IME inset as a reason to steal remote input.
   - Current slice: fullscreen button defaults to aspect-fit letterbox mode; an explicit display-mode control switches to aspect-fill cover mode in both portrait and landscape surfaces. Switching display mode resets local zoom/pan only, never restarts capture or renegotiates WebRTC.
   - Current slice: pinch zoom shows a minimap; zoomed fullscreen single-finger drag pans the projected viewport without restarting the stream.
   - Current slice: QuickBar sequences map to remote-window key/text events for the active stream and do not call terminal input while a supported remote-window input context exists.
   - Current slice: unsupported iTerm2 pane `tmux-input` / `iterm2-api` targets are selectable for video but read-only for input; they do not publish `RemoteWindowInputContext`, do not send pointer/scroll/key payloads, and leave QuickBar routing on the terminal path.
   - Current slice: ImeAnchor input/backspace/key events route to remote-window input context while active; committed CJK, special symbols, and newlines are preserved exactly and do not leak into the terminal session under the video overlay.
   - Current slice: QuickBar image paste sends a remote-window paste target while the remote-window focus context is active, and after terminal surface focus activation the same image button calls the terminal paste path without a paste target.
   - Current slice: bitrate presets are remembered per selected desktop window identity, floating preview effective stream bitrate remains separate and always requests `2mbps`, untouched defaults derive from selected window area divided by daemon display area, and entering Android phone fullscreen does not upgrade bitrate by itself. User selector changes update the active stream quality exactly once and do not call stream start again.
   - Current slice: backgrounding the app while a remote-window stream is active closes the overlay and stops the stream exactly once instead of letting ScreenCaptureKit/WebRTC continue offscreen.
   - Full stream slice: `fullscreenStream + Back -> floatingStream`
   - Full stream slice: `fullscreenStream + minimize -> floatingStream`
   - `close -> closed`
   - Back/minimize must not tear down capture, encoder, or WebRTC sender.
   - Close must release all stream resources exactly once.

7. Catalog transport readiness
   - Current minimal slice: target catalog requests use the existing open session transport only.
   - A session whose UI/runtime state is still `connecting` but whose physical session socket is already `OPEN` must be able to send exactly one `remote-window-targets-request`.
   - Catalog readiness must not reuse image/file paste readiness, because paste requires heavier terminal-session connected semantics.
   - If no open physical session socket exists, the picker must surface an explicit remote-window catalog transport error and must not wait for the paste timeout or emit `Active session is not ready yet`.
   - If `requestTargets()` never resolves or rejects, the overlay's local watchdog must surface `远程窗口列表读取超时` and move to an error state without starting screenshot/video/terminal-buffer fallback.
   - The overlay catalog watchdog must be longer than the daemon app-window catalog timeout, and live catalog probes must wait longer than that daemon timeout; otherwise the client/test times out before the unique daemon catalog owner can return its explicit error.
   - The negative gate must prove catalog failure does not start screenshot, terminal buffer render, hidden video, or transport rebuild fallback.
   - Catalog cache is keyed by daemon identity rather than session id. Opening the picker for a second tmux session on the same daemon must not send a second `remote-window-targets-request` inside the 60-second TTL. A changed daemon endpoint/auth token or expired TTL must issue one fresh request. A closed physical transport must still return an explicit transport error even if a cache entry exists.
   - Daemon runtime startup warms the default app-window+iTerm2 catalog once. A fresh process-local cache request must not rerun Swift/iTerm2 enumeration; an expired cache must return stale targets immediately while exactly one background refresh runs; a first uncached request and explicit `forceRefresh` must await the live owner and surface its real result/error.
   - Cached daemon responses must rewrite the top-level and nested error `requestId` to the current request so concurrent or later callers cannot receive another request's identity.
   - Overlay projection keeps the last successful catalog for the current active session and renders those rows immediately on picker reopen or manual refresh. The first uncached open may show a compact loading row; cached/stale/force-refresh opens must not blank the target list. The Refresh button passes `{ forceRefresh: true }` to the SessionContext catalog owner, bypassing the daemon-wide TTL without creating a second catalog truth.
   - While picker state suppresses the QuickBar, `TerminalPage` stage bottom reserve must be `0`; target-locked floating/fullscreen modes restore the normal QuickBar/IME chrome projection.

8. Input return policy
   - Android pointer/key events are sent only as explicit `remote-window-input` over an existing stream transport.
   - Client touch/input must pass through `remote-window-touch-action-runtime`: the overlay may classify hit-test coordinates and emit an action, but only the touch/action dispatch boundary may report whether the action was sent. `RW事件 SEND Y` is not sufficient E2E evidence unless the same test also observes the physical `WebSocket.send` / `RTCDataChannel.send` frame or the downstream `remote-window-input-result` / `remote-window-error`.
   - Operation-scoped focus is mandatory: selecting a target, stream start, receiver attach, fullscreen entry, IME lift, pinch zoom, and local zoom-pan must not send `focus`; every actual remote pointer/wheel/key/QuickBar/IME event must be immediately preceded by same stream/target `focus`.
   - Screenshot is a non-input operation: floating/fullscreen screenshot button must send no `focus`, must call the existing remote screenshot request owner with `target.kind=remote-window`, must save the returned original-resolution PNG on Android, and daemon must reject invalid target rect/window ids instead of falling back to full-screen capture.
   - Screenshot feedback is part of the black-box gate: click must immediately show a non-layout-changing overlay animation/progress state, completion must show an original-screenshot saved prompt, and tests must prove no local video/canvas screenshot path is used.
   - Android video-surface pointer coordinates must resolve to daemon manifest global macOS top-left coordinates (`crop/window x + normalized * width`); DOM-relative or app-local coordinates are not accepted as a pass. In aspect-fill mode the normalization must use the actual centered cover rect, including cropped negative offsets, rather than pretending the source exactly matches the phone surface.
   - Page-level phone logic gate: render real `TerminalPage`, open the remote-window picker, select an interactive app-window, replay touch pointer tap and unzoomed touch drag on `remote-window-video-surface`, and assert the events leave the page through `onSendRemoteWindowInput` as focus-first pointer down/up for tap and one focus-first `gesture/swipe` action for drag, with no sends during pointer move. The same gate must assert terminal input is not called, so QuickBar/terminal focus routing cannot hide a swallowed video-surface touch path.
   - Installed-phone L5 gate: when WebView DevTools is available, hook `WebSocket.prototype.send` and `RTCDataChannel.prototype.send` before the touch replay and assert at least one outgoing `mux-channel-message` contains `message.type === "remote-window-input"` for each focus-first action pair. If no frame appears, the failure is in client touch/action dispatch, not daemon AX/Quartz injection.
   - Unzoomed touch drag must not stream raw pointer moves; at release it must emit one Android app-window `kind=gesture`, `gesture=swipe`, `phase=end` action containing mapped start/end coordinates, absolute visible-source pixel deltas, duration, and velocity. This remains true when fullscreen has an IME bottom inset. Mouse/trackpad wheel remains `kind=scroll`. Zoomed fullscreen one-finger drag must pan locally and must not emit remote pointer drag. Zoomed fullscreen two-finger vertical movement must emit focus-first pixel `scroll` actions from the midpoint without moving the local projection; the tuning gate must prove 1/8, 1/4, 1/2, and 1 screen presets change only delta magnitude by visible source size and direction inversion flips only the delta sign while preserving mapped coordinates.
   - DOM positive-down/right scroll deltas remain the wire contract. The daemon must negate them exactly once when constructing macOS `CGEvent` wheel values.
   - The daemon macOS input schema must match the protocol union: pointer/key events require `phase`; scroll events do not carry `phase` and must still decode and inject.
   - The daemon owns a persistent Swift input helper for a selected stream/runtime. Interactive app-window stream start must warm and readiness-check the helper without emitting focus/input, so helper cold start is not charged to the first realtime user operation. Pointer, scroll, and key sequences must not compile a fresh `swift -e` process per event. Repeated focus requests must short-circuit when the target app is already frontmost and the matched AX window is already focused; otherwise phone-style focus-first bursts can block the helper queue until the following pointer/key operation becomes stale. Queued real input older than one second must still be dropped before helper injection.
   - Cross-device `clientSentAt` is debug metadata only. Daemon input stale/drop decisions must use daemon-local receive/enqueue time, not Android/Mac wall-clock comparison. Red/green must prove missing, old, and future `clientSentAt` payloads can still be accepted when daemon receive time is fresh, while a daemon-local queued request older than one second is rejected before helper injection.
   - Local action loopback is the required bridge before Android real-device proof: the live probe launches a temporary AppKit `.app`, starts a real app-window stream, maps local actions `tap`, `drag`, `scroll`, and `key` into focus-first remote-window input payloads, and asserts AppKit stdout sees mouse down/up, mouse dragged, scroll, and key markers. The same probe must run raw WebSocket and mux-channel paths with `ZTERM_REMOTE_WINDOW_PROBE_CLIENT_CLOCK_OFFSET_MS=-60000` so phone/Mac clock skew cannot be hidden by same-host tests, and with `ZTERM_REMOTE_WINDOW_PROBE_BURST=1` so phone/WebView behavior that sends focus + pointer/key/text back-to-back cannot be hidden by a serial ACK-after-each-event probe. A serial live probe proves only protocol reachability; it is not a phone-parity gate for remote-window input stale bugs.
   - Remote-window image paste must use the same paste-image upload owner but with an explicit remote-window target, causing daemon clipboard write plus Command+V injection for the selected stream. Terminal focus must remove that target and keep the existing terminal Ctrl+V path.
   - QuickBar key/text/IME input must use the same active stream id and target id as the visible overlay; stale stream ids after close/shrink/reselect are a failure.
   - The real `<video>` receiver is pointer-transparent; fullscreen and floating hit tests belong to the overlay video surface so user taps are not swallowed by media playback.
   - `bring-to-focus + os-event` matches the target AX window by manifest bounds, activates/raises it, and focuses target before forwarding mouse/keyboard/scroll.
   - `no-focus-steal + os-event` rejects generic app input explicitly.
   - `no-focus-steal + iterm2-api` and `no-focus-steal + tmux-input` may pass only for declared terminal-specific targets.

9. Catalog bandwidth isolation
   - With runtime debug disabled, queued `terminal.performance.trace` metadata must not be flushed as `debug-log` frames over the session WebSocket.
   - Enabling runtime debug is temporary and expires, so a stale client setting cannot keep uploading diagnostics before remote-window video starts.

10. Stream protocol and lifecycle
   - `remote-window-stream-start-request` carries one selected daemon manifest plus a WebRTC receive offer over the existing session transport.
   - Android derives the remote-window video ICE servers from the current session traversal route: `rtc-direct` uses STUN-only direct ICE, `rtc-relay` uses TURN relay ICE, and direct WebSocket/Tailscale paths do not fabricate relay ICE.
   - `remote-window-stream-started` carries the answer, stream id, target id, and capture metadata; route/ICE diagnostics remain metadata and do not prove video success.
   - `remote-window-stream-ice-candidate` is tied to a stream id and cannot create or select a target by itself.
   - `remote-window-stream-status` can report `starting`, `streaming`, and `stopped`, but `streaming` requires real capture/media readiness from the daemon stream owner.
   - `remote-window-stream-stop-request` releases capture/media/timers exactly once.
   - `remote-window-error` for stream start/capture/media must not be converted into an empty catalog, waiting state, screenshot success, or terminal-buffer preview.
   - Backgrounding the app while a remote-window stream is active must call the stop owner exactly once, clear the overlay, and restore body/quickbar suppression baseline.

11. Android receiver state
   - Selecting a manifest starts media negotiation and moves from `targetLocked` to an honest stream setup state.
   - Receiver attach binds a stream id and media stream to the selected target.
   - Late started/status/candidate messages for a stale or closed stream cannot revive the overlay.
   - Back/minimize keep the same stream id; close sends stop.
   - The video surface must render a real `<video>`/receiver-backed surface or an explicit setup/error state. It must not read `TerminalView`, `sessionBufferStore`, sparse rows, screenshot preview state, or mocked frame data as the business source.

12. Daemon stream owner
   - Capture starts only from the selected target manifest and rejects missing targets, missing/invalid crop rects, permission failures, and media setup failures explicitly.
   - Capture frames must originate from ScreenCaptureKit/window capture and be fed into the WebRTC video sender; unit tests may inject a fake frame source only to lock lifecycle and cleanup.
   - Stream start must use a sender path that negotiates an actual `sendonly` video track. In the current `@roamhq/wrtc` runtime, `addTransceiver(videoTrack, { sendEncodings })` can produce an `inactive` answer even after ScreenCaptureKit sends frames; this is a red gate because Android waits for `ontrack`.
   - Bitrate apply preserves the sender's existing `RTCRtpSendParameters.encodings` count/order and changes only `maxBitrate`. The positive gate proves existing encodings are updated after a sendonly-safe sender is attached; the negative gate starts with `encodings=[]`, proves `setParameters()` is not called and video start still returns an answer without `capture.maxBitrateBps`, then proves a live quality update returns `remote_window_stream_quality_failed`.
   - Close, media failure, capture process exit, and transport failure must share one exactly-once cleanup path.
   - Frame success is not complete until a live pixel oracle matches a source marker to receiver pixels.
   - Android receiver track timeout must be longer than the daemon ScreenCaptureKit startup timeout. Since the daemon does not return the WebRTC answer until capture produces the first frame or fails explicitly, a shorter receiver timeout turns a daemon-owned capture delay into a misleading client receiver error.

## Black-Box Mac Gates

1. iTerm2 coordinate crop proof
   - Reuse existing iTerm2 instance when possible.
   - If a test window is required, create one marked with `ZTERM_ITERM_COORD_TEST_<run_id>`.
   - Create two or more colored panes with unique markers.
   - Read app/window top-left frame through Accessibility/System Events.
   - Read pane relative frames through iTerm2 Python API.
   - Flatten nested splitter offsets before computing pane crop rects.
   - Crop each pane and assert own-color pixels exceed threshold while wrong-color pixels remain below threshold.
   - Assert an inverted-y crop formula fails against the same marker oracle.
   - Move/resize the window and repeat.
   - Close the marked test window and clean temp files in `finally`.

2. tmux reverse lookup proof
   - Enumerate iTerm2 sessions and tty values.
   - Compare each tmux-backed pane with `tmux list-clients`.
   - Assert iTerm2 grid size and tmux client grid agree.
   - Do not write to user tmux sessions. Use read-only enumeration unless a marked test session is explicitly created.

3. Generic app-window catalog proof
   - Enumerate real non-iTerm2 app windows through the daemon catalog.
   - Assert at least one non-iTerm2 `app-window` manifest has bundle id, pid, window id, title, top-left bounds, crop rect, `focusPolicy=bring-to-focus`, and `inputRoute=os-event`.
   - Assert iTerm2 pane rows are still present when the iTerm2 API is available.

4. ScreenCaptureKit stream proof
   - Start capture on a selected iTerm2 pane.
   - Start capture on a selected non-iTerm2 app window.
   - Receive real frames through the WebRTC sender path.
   - Pixel-check the Android/Web receiver frame against the selected marker.
   - Verify covered desktop windows do not produce false success. If window capture is occlusion-independent, record the capture source metadata.

5. Lifecycle cleanup proof
   - Before test: list existing iTerm2 windows, tmux sessions, daemon PIDs, WebRTC ports, temp dirs.
   - After test: verify no unmarked iTerm2 test window, tmux session, pipe-pane, debug port, venv, or temp dir remains.
   - Fixed reusable resources must have a marker and owner/case note.

6. Generic app focus and scroll proof
   - Require `AXIsProcessTrusted() == true`; missing Accessibility permission is an explicit failure.
   - Create a marked AppKit target window and a separate covering window whose bounds overlap the target center.
   - Verify posting pixel scroll to the target point while covered does not move the target.
   - Match the target AX window by its `CGWindowList` bounds, activate the app, `AXRaise` that window, and verify it becomes frontmost and key/focused before returning accepted input.
   - Verify Android sends no remote `focus` input intent when a supported app-window stream is selected, started, attached, expanded fullscreen, shrunk, closed, or screenshotted. Video-surface pointerdown/up, wheel, and key paths must send `focus` before the corresponding pointer/scroll/key event, and QuickBar/IME batches must send `focus` before key/text events. Read-only iTerm pane targets must emit none of these intents.
   - Post pixel scroll through `CGEvent.post(tap: .cghidEventTap)` using the `CGWindowList` top-left target point directly; no AppKit bottom-left conversion is allowed for daemon manifest coordinates.
   - Use a flipped document view so increasing content `y` has unambiguous down-scroll semantics.
   - Through the live daemon WebSocket protocol, start a real app-window stream against a marked AppKit probe window, send pointer tap down/up, gesture/swipe, pixel scroll, and key down/up over `remote-window-input`, and assert both protocol `accepted=true` and probe stdout events are observed. Use `pnpm --dir android exec tsx scripts/remote-window-live-input-probe.ts`; the probe must launch a temporary `.app` bundle so the daemon tests normal macOS app focus semantics rather than an unbundled Swift script. The Android app-window touch gate must assert drag emits exactly one gesture payload and no raw pointer move stream.
   - For WeChat or another ordinary app, first activate a different app, then send a harmless pointer move over the live daemon stream and assert `System Events` frontmost app changes to the selected target app. This is the black-box guard for AX window matching + `AXRaise`.
   - Assert negative macOS `wheel1` moves content down and positive `wheel1` moves it back up. This locks the one-time DOM-to-CGEvent sign conversion.
   - Close the marked window and leave no test process or temporary file.

## Black-Box Android Gates

The picker and target-locked overlay shell are covered now. Gates that require a real frame or remote input remain pending until the ScreenCaptureKit/WebRTC receiver and input-return slices exist.

1. Floating entry
   - Tapping the floating entry opens the remote window picker.
   - Dragging the floating entry moves only that entry and suppresses the synthetic click from the same pointer sequence.
   - The entry and other floating command bubbles must be clamped below the Android status-bar guard so they cannot sit on top of system icons.

2. Picker
   - App/window list renders daemon catalog rows.
   - iTerm2 pane rows are collapsed by default and expand only after explicit group activation.
   - iTerm2 pane rows show tmux reverse lookup metadata when available.
   - Missing permission/catalog failures surface explicit errors.

3. Overlay
   - Current minimal slice: selecting a pane locks the floating overlay shell to the exact manifest and displays an honest waiting state.
   - Current minimal slice: dragging the floating toolbar moves the overlay without entering fullscreen or closing it; the regression must assert `setPointerCapture/releasePointerCapture` so Android WebView does not lose the drag when `window.pointermove` is unreliable.
   - Full stream slice: selecting a pane starts the floating stream overlay and binds a real stream id.
   - Double tap enters fullscreen with aspect-fit letterbox as the default.
   - Explicit fullscreen button enters fullscreen.
   - The fullscreen display-mode control switches between complete aspect-fit and aspect-fill cover; cover fills both portrait and landscape phone surfaces without stretching the source, changing daemon capture, or creating a second stream.
   - Pinch zoom enlarges the fullscreen video, one-finger drag pans while zoomed, and the top-right minimap marks the visible viewport.
   - Fullscreen overlay top chrome must respect Android safe-area/status-bar inset and must not overlap system status icons.
   - Opening the IME while the floating stream is target-locked moves the preview above the QuickBar/keyboard rather than leaving it under the keyboard.
   - Opening the IME in fullscreen keeps local pan available even when the selected source exactly fills the video surface; upward pan must reduce bottom padding instead of resizing the page shell or sending remote scroll.
   - Current minimal slice: Back/minimize shrinks to the same target-locked floating shell.
   - Full stream slice: Back/minimize keeps the same stream id.
   - Current minimal slice: close removes the overlay and invalidates outstanding catalog response epochs.
   - Full stream slice: close tears down the stream and removes overlay.

4. Input
   - Android overlay maps pointer coordinates from the actual aspect-fit, aspect-fill, or zoomed content rect to the selected target crop.
   - A single-finger drag on an unzoomed floating/fullscreen video is recognized locally and sends one release-time gesture/swipe action to the selected target; raw pointer moves are not sent or queued.
   - Android IME CJK/special-character/newline committed text reaches the selected app unchanged and does not enter the terminal session.
   - With `bring-to-focus`, a click/key event raises/focuses the selected target window and reaches it even when another window previously covered the target point.
   - With `no-focus-steal`, generic app OS input returns an explicit policy error.
   - With `tmux-input`, a terminal key marker appears in the selected tmux pane only.

## Completion Rule

This feature is not closed by static docs, one-shot screenshots, terminal buffer comparisons, or a mock receiver. Completion requires real iTerm2 coordinate proof, real ScreenCaptureKit/WebRTC frame delivery, Android overlay behavior, and cleanup evidence.
