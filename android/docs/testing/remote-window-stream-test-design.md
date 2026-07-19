# Remote Window Stream Test Design

## Scope

Feature id: `desktop.remote_window_stream`

This gate covers remote app/window and iTerm2 pane video streaming from a daemon host to Android, plus the future input-return contract. The stream is a desktop media resource, not terminal buffer truth.

## White-Box Gates

1. Resource/function/mainline gates
   - `src/lib/resource-registry-truth.test.ts`
   - `src/lib/function-map-resource-truth.test.ts`
   - `src/lib/mainline-resource-call-map.test.ts`
   - `src/lib/function-wiki-truth.test.ts`
   - `src/lib/feature-registry-truth.test.ts`

2. Coordinate normalization
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

5. Overlay state machine
   - `fullscreenStream + Back -> floatingStream`
   - `fullscreenStream + minimize -> floatingStream`
   - `close -> closed`
   - Back/minimize must not tear down capture, encoder, or WebRTC sender.
   - Close must release all stream resources exactly once.

6. Input return policy
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

3. ScreenCaptureKit stream proof
   - Start capture on a selected iTerm2 pane.
   - Receive real frames through the WebRTC sender path.
   - Pixel-check the Android/Web receiver frame against the selected marker.
   - Verify covered desktop windows do not produce false success. If window capture is occlusion-independent, record the capture source metadata.

4. Lifecycle cleanup proof
   - Before test: list existing iTerm2 windows, tmux sessions, daemon PIDs, WebRTC ports, temp dirs.
   - After test: verify no unmarked iTerm2 test window, tmux session, pipe-pane, debug port, venv, or temp dir remains.
   - Fixed reusable resources must have a marker and owner/case note.

## Black-Box Android Gates

1. Floating entry
   - Existing floating quick entry is removed or hidden for the stream mode.
   - Tapping the floating entry opens the remote window picker.

2. Picker
   - App/window list renders daemon catalog rows.
   - iTerm2 rows expand into tab/pane rows.
   - iTerm2 pane rows show tmux reverse lookup metadata when available.
   - Missing permission/catalog failures surface explicit errors.

3. Overlay
   - Selecting a pane starts floating stream overlay.
   - Double tap enters fullscreen letterbox.
   - Back shrinks to floating overlay and keeps the same stream id.
   - Minimize shrinks to floating overlay and keeps the same stream id.
   - Close tears down the stream and removes overlay.

4. Input
   - With `bring-to-focus`, a click/key event focuses the selected target and reaches it.
   - With `no-focus-steal`, generic app OS input returns an explicit policy error.
   - With `tmux-input`, a terminal key marker appears in the selected tmux pane only.

## Completion Rule

This feature is not closed by static docs, one-shot screenshots, terminal buffer comparisons, or a mock receiver. Completion requires real iTerm2 coordinate proof, real ScreenCaptureKit/WebRTC frame delivery, Android overlay behavior, and cleanup evidence.
