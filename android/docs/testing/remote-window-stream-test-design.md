# Remote Window Stream Test Design

## Scope

Feature id: `desktop.remote_window_stream`

This gate covers remote app/window and iTerm2 pane video streaming from a daemon host to Android, plus the future input-return contract. The stream is a desktop media resource, not terminal buffer truth.

## Current Minimal Android Slice

The current implemented Android slice is intentionally narrower than feature completion:

1. `TerminalPage` renders the remote-window floating entry and passes only the active session id plus the SessionContext catalog request callback.
2. The picker requests and renders the daemon `RemoteWindowStreamTargetManifest[]` catalog, including explicit partial and top-level errors.
3. Selecting one manifest locks a floating overlay shell to that target; toolbar drag repositions only the floating projection, double tap/double click on the video surface enters fullscreen, Back/minimize returns to floating, and close invalidates the UI state.
4. While the picker or locked overlay is open, `TerminalPage` suppresses the terminal quickbar/input shell and asks the existing IME owner to hide the system keyboard. The overlay does not create a second terminal input path.
5. The shell displays `等待视频流`. It does not claim that capture started and does not use terminal mirror, sparse buffer, renderer rows, screenshot runtime, or any synthetic frame source as video.
6. ScreenCaptureKit capture, WebRTC frame delivery, stream-id lifecycle, and input return remain pending and are still required by the completion rule.

Current executable gates:

- `src/lib/remote-window-message-runtime.test.ts`
- `src/lib/remote-window-overlay-runtime.test.ts`
- `src/components/terminal/RemoteWindowOverlay.test.tsx`
- `src/pages/TerminalPage.remote-window-overlay.test.tsx`
- `src/contexts/session-context-remote-window-runtime.test.ts`
- `src/contexts/session-context-socket-message-runtime.test.ts`

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
   - Current minimal slice: `close -> closed`, with no frame source fabricated.
   - Current minimal slice: `pickerOpen/targetLocked` reports open state to `TerminalPage`; the quickbar/input shell is not rendered while the overlay owns the surface, and it returns after close.
   - Current minimal slice: toolbar pointer drag changes the floating projection offset, remains bounded to the viewport, and is disabled in fullscreen; video/input surface gestures remain separate.
   - Full stream slice: `fullscreenStream + Back -> floatingStream`
   - Full stream slice: `fullscreenStream + minimize -> floatingStream`
   - `close -> closed`
   - Back/minimize must not tear down capture, encoder, or WebRTC sender.
   - Close must release all stream resources exactly once.

7. Input return policy
   - `bring-to-focus + os-event` focuses target before forwarding mouse/keyboard.
   - `no-focus-steal + os-event` rejects generic app input explicitly.
   - `no-focus-steal + iterm2-api` and `no-focus-steal + tmux-input` may pass only for declared terminal-specific targets.

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

## Black-Box Android Gates

The picker and target-locked overlay shell are covered now. Gates that require a real frame or remote input remain pending until the ScreenCaptureKit/WebRTC receiver and input-return slices exist.

1. Floating entry
   - Existing floating quick entry is removed or hidden for the stream mode.
   - Tapping the floating entry opens the remote window picker.

2. Picker
   - App/window list renders daemon catalog rows.
   - iTerm2 rows expand into tab/pane rows.
   - iTerm2 pane rows show tmux reverse lookup metadata when available.
   - Missing permission/catalog failures surface explicit errors.

3. Overlay
   - Current minimal slice: selecting a pane locks the floating overlay shell to the exact manifest and displays an honest waiting state.
   - Current minimal slice: dragging the floating toolbar moves the overlay without entering fullscreen or closing it.
   - Full stream slice: selecting a pane starts the floating stream overlay and binds a real stream id.
   - Double tap enters fullscreen letterbox.
   - Current minimal slice: Back/minimize shrinks to the same target-locked floating shell.
   - Full stream slice: Back/minimize keeps the same stream id.
   - Current minimal slice: close removes the overlay and invalidates outstanding catalog response epochs.
   - Full stream slice: close tears down the stream and removes overlay.

4. Input
   - With `bring-to-focus`, a click/key event focuses the selected target and reaches it.
   - With `no-focus-steal`, generic app OS input returns an explicit policy error.
   - With `tmux-input`, a terminal key marker appears in the selected tmux pane only.

## Completion Rule

This feature is not closed by static docs, one-shot screenshots, terminal buffer comparisons, or a mock receiver. Completion requires real iTerm2 coordinate proof, real ScreenCaptureKit/WebRTC frame delivery, Android overlay behavior, and cleanup evidence.
