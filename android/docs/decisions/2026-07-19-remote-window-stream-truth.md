# 2026-07-19 remote window stream truth

## Purpose

This decision defines the first architecture contract for remote desktop window video streaming from a daemon host to Android. It is separate from terminal buffer/render truth and separate from one-shot remote screenshot file transfer.

## Product Contract

Remote window stream starts from the Android floating entry. The old floating quick entry may be hidden or repurposed while this feature is under construction. Tapping the floating entry opens a picker:

1. Choose a remote app/window.
2. If the app is iTerm2, enumerate iTerm2 tabs/panes and the tmux client/session mapping.
3. Choose one window or pane target.
4. Start a floating live video overlay.
5. Double tap the overlay to enter fullscreen letterbox mode.
6. Android system Back in fullscreen shrinks back to floating mode.
7. The fullscreen top-right minimize button also shrinks back to floating mode.
8. The close button tears down the stream.

The stream is not view-only long term. It must support mouse and keyboard event return. Input return must carry an explicit focus policy:

- `bring-to-focus`: the daemon brings the selected app/window/pane to focus before forwarding OS input.
- `no-focus-steal`: the daemon must not claim generic OS mouse/keyboard success for normal apps. Terminal-specific routes may still use iTerm2 API or tmux input if declared.

## Resource Boundary

Two resources are introduced:

- `resource.remote_window_overlay`: Android picker/floating/fullscreen projection and user intent.
- `resource.remote_window_stream`: daemon/native catalog, coordinate manifest, capture, encoder/WebRTC sender, target lease, and input injection truth.

`resource.remote_window_overlay` may project UI state and emit stream/input intents. It must not compute macOS coordinates, read iTerm2 split trees, or inject remote input.

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

Current status is `binding pending`. The architecture/resource/function/mainline maps are created before runtime code. Implementation must replace pending doc owners with real owner files and tests in the same change set that introduces behavior.
