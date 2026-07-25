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
6. Use the explicit fullscreen button next to close, or double tap the video surface, to enter fullscreen. Fullscreen defaults to complete aspect-fit letterbox mode.
7. Android system Back in fullscreen shrinks back to floating mode.
8. The fullscreen top-right minimize button also shrinks back to floating mode.
9. Fullscreen preserves source aspect ratio. The default display mode is aspect-fit complete display; the explicit fill control sends a remote target resize request for the current phone surface instead of doing a local cover/crop. Pinch zoom can only enlarge above fit, zoomed fullscreen allows one-finger pan, and there is no minimap/viewport overlay.
10. Opening the Android IME lifts the target-locked floating preview by the same bottom inset as the QuickBar so the preview remains visible above the keyboard. In fullscreen, the same bottom inset is consumed as overlay padding and `bottomChromeInsetPx` may auto-lift the projection, but unzoomed single-finger touch still belongs to the remote app: tap sends one `click` action and drag sends one release-time `gesture/swipe` action with start/end coordinates and deltas, without streaming raw pointer moves. Local single-finger pan is reserved for zoomed fullscreen projection.
11. On an unzoomed video surface, a single-finger drag is recognized locally and sent at release as one `gesture/swipe` action with absolute start/end target coordinates. Android must not stream raw touch move events or queue delayed multi-event mouse drags. Mouse/trackpad wheel remains explicit pixel scroll input. In zoomed fullscreen mode, the same touch drag remains local pan.
12. The close button tears down the stream.
13. Floating and fullscreen overlays expose a screenshot button. It captures the selected desktop app/window target through the existing remote screenshot/file-download pipeline, using the target manifest to request either the macOS window id or normalized pane crop rectangle, then saves the PNG on Android. Screenshot capture is not remote input and must not focus or raise the desktop app.
14. When the Android app goes to background, an active remote-window stream is explicitly stopped and the overlay closes instead of keeping ScreenCaptureKit/WebRTC alive offscreen. Foreground return does not auto-resume a hidden stream; the user must reopen the overlay.

The stream is not view-only long term. It must support mouse and keyboard event return. Input return must carry an explicit focus policy:

- `bring-to-focus`: the daemon brings the selected app/window/pane to focus before forwarding OS input.
- `no-focus-steal`: the daemon must not claim generic OS mouse/keyboard success for normal apps. Terminal-specific routes may still use iTerm2 API or tmux input if declared.

Generic app OS input requires macOS Accessibility permission. App activation alone is not enough for covered or background windows, including apps such as WeChat. The daemon input config must carry the target window id/title/bounds, match the Accessibility window by bounds, check the current frontmost PID, activate the owning app only when the target is not already frontmost/focused, `AXRaise` the matched window, set it as focused/main when supported, verify that the app is frontmost and the target window is focused, and only then post Quartz events. Client-sent `focus` remains a compatibility/explicit bring-front intent, but it is not the required queue item before every real operation; real click, wheel, key, QuickBar, IME, and gesture actions must leave Android as one action record and perform the same daemon-owned frontmost/focused check inline before injection. Stream start, video attach, fullscreen entry, IME lift, picker/catalog refresh, pinch zoom, local zoom-pan setup, close, and screenshot must not focus the desktop app. Event coordinates use the daemon manifest/`CGWindowList` top-left coordinate space directly. Android IME committed text is sent without terminal punctuation/newline normalization. Android/DOM scroll deltas use positive values for down/right, while macOS `CGEvent` pixel wheel values use the opposite sign; the daemon input owner performs that conversion exactly once. The daemon input owner also owns the macOS helper lifecycle: click/pointer/scroll/key sequences and daemon-only legacy gesture compatibility must go through one ready-checked persistent Swift helper, not a fresh `swift -e` compilation per event. The helper cold start is warmed during interactive stream start without emitting focus/input; the one-second realtime stale/drop rule applies only to actual queued user operations after helper readiness, not to helper startup. Same-target action-only bursts may refresh each next queued action only after the preceding same-target action succeeds, so one slow inline focus check does not stale the whole burst; different-target or unrelated queued actions still drop when daemon-local stale time expires. The Swift decode schema must match the wire union, so focus/scroll/click events omit `phase`, legacy gesture events carry `phase=end`, and pointer/key events require `phase`.

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

Floating preview geometry and fullscreen zoom state are Android projection-only. The floating preview uses the selected manifest crop/window aspect ratio instead of a fixed frame. Fullscreen local drawing/input stays aspect-fit; the fill action is an explicit daemon `window-resize` request against the selected app-window target and must not be faked by local cover/crop, tmux resize, capture restart, WebRTC renegotiation, or coordinate fallback. Pinch zoom may only enlarge above fit; the client must not render a minimap/viewport overlay or allow shrinking below fit once fullscreen is established. Pointer/keyboard events emitted from the video surface are normalized against the selected manifest crop and sent as explicit input intents; the media `<video>` is pointer-transparent and daemon/native input policy is still the only injection truth.

Remote-window media negotiation is a separate WebRTC peer connection, but its ICE configuration must be derived from the current session traversal route. When the active session resolved through `rtc-direct`, the video receiver/start request uses the same STUN-only direct ICE truth. When it resolved through `rtc-relay`, the video receiver/start request uses the Relay TURN ICE truth. Android must not leave the remote-window video peer connection as no-ICE on Relay/cellular paths, and must not invent a screenshot or terminal-buffer fallback if ICE/media negotiation fails.

Video quality is stream-local control, not transport lifecycle. Android may remember a bitrate preset per selected desktop window identity and seed untouched defaults from daemon-provided desktop display coverage: selected crop/window area divided by `capture.displayBoundsTopLeftPx` area. Floating preview effective requests remain low at `2mbps`. Android phone fullscreen is display projection only and must not upgrade bitrate by itself; only near-full desktop display coverage maps to `fullscreen`/20Mbps. Network quality may cap the effective preset without raising the user's remembered selection: `2mbps` is capped at 5 FPS, `5mbps` at 8 FPS, and `10mbps`/`20mbps`/`fullscreen` at 12 FPS. `saveData`, 2G/slow-2G, downlink below 0.8 Mbps, or RTT at least 800 ms cap at 2 Mbps; 3G, downlink below 2 Mbps, or RTT at least 500 ms cap at 5 Mbps; downlink below 5 Mbps or RTT at least 250 ms cap at 10 Mbps. Changing bitrate or projection mode must not restart capture, recreate the receiver, rebuild the session transport, or change daemon coordinate truth. The daemon stream owner applies the requested sender bitrate and frame rate only by preserving the WebRTC sender's existing `RTCRtpSendParameters.encodings` count/order; it must not fabricate an encoding entry when `encodings` is empty. Empty sender encodings during stream start mean quality is explicitly not applied and `capture.maxBitrateBps` is omitted while video startup continues; the same condition during a live quality update is an explicit unsupported quality error. Unsupported or inconsistent bitrate/frame-rate payloads are rejected explicitly.

The remote-window app catalog is daemon-wide projection data, not tmux-session data. The Android client keeps a 60-second cache keyed by `{ daemonHostId, bridgeHost, bridgePort, authToken }`, so switching between sessions on the same daemon reuses the last catalog rather than sending another full enumeration. Cache expiry requests one fresh catalog; a closed physical session transport is still an explicit error and cannot be hidden by stale catalog data. The cache does not create a second WebSocket and does not replace the existing `SessionContext` transport owner.

Image paste follows the current focus owner. When the active focus owner is a remote-window stream, Android sends the normal paste-image upload with `pasteTarget.kind=remote-window`; the daemon writes the macOS clipboard and injects Command+V through the remote-window input owner for that stream/target. When terminal surface focus is activated, Android clears the remote-window input context and the same QuickBar image action remains on the terminal paste path, writing the macOS clipboard and sending the terminal Ctrl+V sequence. The daemon must not guess focus from the desktop window list or app title.

## Explicit Errors

The daemon must fail explicitly for:

- Screen Recording permission missing
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

No fallback may silently downgrade this feature to screenshot, terminal buffer render, or stale cached image.

## Implementation Status

Current status is anchored for app-window catalog, collapsed same-app picker rows plus active video-layer primary-plus-children sibling window switching inside the same locked video container, portrait child rail above the primary video and landscape child rail beside it, default-collapsed iTerm2 picker grouping, real ScreenCaptureKit/WebRTC video, Android floating/fullscreen projection with safe-area top chrome and TerminalPage-measured QuickBar + IME bottom-inset lift for the whole locked container, toolbar-reachable floating resize, fullscreen aspect-fit default plus explicit remote target resize fill request, fullscreen zoom/pan without any minimap overlay, route-derived ICE for remote-window video, per-window bitrate start/update control, focus-aware image paste routing, raw Android IME text routing, touch tap/mouse click to one `click` action, drag to one release-time gesture/swipe action, target-locked two-finger release-time gesture action, plus one wheel pixel-scroll action for supported app-window targets, read-only projection for unsupported iTerm pane input routes, generic `bring-to-focus + AXRaise + os-event` click/scroll/key injection with daemon gesture replay, and remote-window screenshot requests that reuse the existing remote screenshot/file-download path without focus. Remaining live completion gaps are Android real-device input replay after this interaction slice, live remote-window screenshot proof on installed daemon, and iTerm2-pane stream/input proof.
Current status is also anchored for foreground/background power safety: backgrounded app state is a close/stop signal for any active remote-window stream and must not leave the receiver or capture pipeline running offscreen.
