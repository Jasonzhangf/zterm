# Remote Window Stream Video Goal Plan

Last updated: 2026-07-19

## Objective

Complete `desktop.remote_window_stream` from the current catalog and overlay shell into a real remote desktop video mainline:

- Mac daemon enumerates and selects a real app window or iTerm2 pane.
- Daemon starts a real desktop capture source for the selected manifest.
- Captured frames are transmitted through the declared remote-window stream transport.
- Android `RemoteWindowOverlay` renders the real remote video frames in floating and fullscreen modes.
- Only after real video is implemented and verified may the Android APK be built and handed to Jason for testing.

## Acceptance Criteria

1. Android remote-window overlay displays real remote video frames from the selected Mac window or iTerm2 pane.
2. The rendered frame is verified by a pixel oracle against a marker placed in the selected source target.
3. The feature does not use terminal mirror rows, sparse buffer rows, renderer rows, static screenshots, fake video, or mock receiver output as stream truth.
4. iTerm2 pane coordinates are normalized only on the daemon side and match the verified top-left crop model in `android/docs/decisions/2026-07-19-remote-window-stream-truth.md`.
5. A non-iTerm2 app-window target and an iTerm2 pane target are both covered by live capture/receiver proof, unless a platform permission or OS limitation is proven with explicit blocker evidence.
6. Close tears down capture, encoder/transport, timers, temp files, and stream state exactly once.
7. Resource map, registry, function map, mainline call map/source, and test design stay synchronized with the implemented code.
8. Required white-box, black-box, live daemon, live Android receiver, and pixel/frame gates pass.
9. APK build happens only after the real-video gates pass.

## Scope

In scope:

- Remote-window stream protocol messages for start, status, error, stop, and frame/receiver setup.
- Daemon stream lifecycle owner for capture start, frame delivery, stop, error projection, and cleanup.
- Mac capture implementation for `app-window` and `iterm2-pane` manifests.
- Android overlay state transition from target-locked waiting shell to real stream receiver/render surface.
- Floating drag, fullscreen letterbox, explicit fullscreen button, pinch zoom, zoomed pan, minimap, Back shrink, minimize, and close semantics.
- Live gates using real daemon, real catalog, real target marker, and receiver pixel checks.
- Documentation and machine-readable map updates for the new lifecycle edges.

Out of scope for this goal:

- Full mouse/keyboard event return implementation, except preserving protocol/design room and focus-policy semantics.
- Redesigning terminal buffer, renderer, session drawer, relay login, or unrelated connection flows.
- Shipping an APK before real video is proven.
- Replacing the existing catalog implementation when it already matches the resource boundary.

## Architecture Boundary

Feature id: `desktop.remote_window_stream`

Primary resources:

- `resource.remote_window_overlay`: Android picker/floating/fullscreen projection and user intent only.
- `resource.remote_window_stream`: daemon/native catalog, coordinate manifest, capture, encoder/WebRTC sender, target lease, and input injection truth.
- `resource.session_transport`: existing control-plane route used by Android to request catalog/start/stop and receive control/status messages.
- Any newly introduced media/RTC/capture resource must be added to `android/docs/resource-registry.json` and `android/docs/resource-map.md` before implementation.

Allowed path:

```text
Android overlay intent
  -> active session/session transport control message
  -> daemon remote-window stream owner
  -> native Mac target manifest/capture owner
  -> media transport sender
  -> Android receiver/render surface
```

Forbidden paths:

- Android overlay computing macOS/iTerm2 coordinates.
- Remote-window stream reading terminal mirror/client sparse buffer/renderer rows as video.
- Daemon storing client UI state such as foreground/background, active tab, viewport, follow mode, or IME state.
- Screenshot loop, static image, terminal preview, or mock receiver being reported as streaming success.
- Debug/config/provider/cache/control metadata mixed into business frame payload.
- Silent fallback from stream failure to empty success or fake success.

## Mainline Call IDs

Use existing IDs where present. If a required edge is missing, add it before code changes and mark `binding pending` until the real symbol exists.

- `desktop.remote_window_stream.catalog.request`
- `desktop.remote_window_stream.catalog.response`
- `desktop.remote_window_stream.start.request`
- `desktop.remote_window_stream.daemon.capture.start`
- `desktop.remote_window_stream.daemon.capture.frame`
- `desktop.remote_window_stream.transport.offer_answer`
- `desktop.remote_window_stream.android.receiver.attach`
- `desktop.remote_window_stream.android.frame.render`
- `desktop.remote_window_stream.lifecycle.stop`
- `desktop.remote_window_stream.lifecycle.cleanup`

Each map edge must be adjacent only. Do not write shortcut edges from overlay directly to native capture internals.

## Technical Plan

### Protocol

Update `packages/shared/src/connection/protocol.ts` and focused tests with typed messages for:

- stream start request
- stream start/status result
- stream setup error
- receiver negotiation or frame transport setup
- stream stop request
- stream stopped/cleanup status when needed

Protocol rules:

- Request, response/status, frame/media, and error chains stay explicit.
- Stream ids are lifecycle ids, not client session truth.
- Debug metadata is side-channel only.
- Errors are projected as errors, not empty target lists or waiting states.

### Daemon

Update daemon owner files around:

- `android/src/server/remote-window-stream-daemon.ts`
- `android/src/server/terminal-message-runtime.ts`
- daemon wiring in `android/src/server/server.ts` or the current server entry

Daemon responsibilities:

- Validate selected manifest still exists and is drawable.
- Start real Mac capture from the selected app-window or iTerm2 pane target.
- Crop iTerm2 pane using the daemon-normalized manifest.
- Start media sender/transport and emit explicit stream status.
- Deliver frames only from the capture source.
- Stop and cleanup exactly once.
- Reject missing permission, missing source, invalid rect, capture failure, negotiation failure, and closed stream explicitly.

### Android

Update Android UI/runtime owner files around:

- `android/src/components/terminal/RemoteWindowOverlay.tsx`
- `android/src/lib/remote-window-overlay-runtime.ts`
- `android/src/lib/remote-window-message-runtime.ts`
- `android/src/contexts/session-context-remote-window-runtime.ts`
- `android/src/contexts/session-context-socket-message-runtime.ts`

Android responsibilities:

- Picker selection sends start-stream intent for the selected manifest.
- Overlay binds the returned stream id and attaches receiver/render surface.
- Floating toolbar drag moves only the projection.
- Double tap or the explicit fullscreen button enters fullscreen letterbox.
- Back and minimize shrink fullscreen to floating without teardown.
- Fullscreen pinch zoom shows a minimap, and zoomed fullscreen supports one-finger pan.
- Close sends stop and invalidates late status/frame messages.
- QuickBar and IME shell remain suppressed for picker/fullscreen only; floating video keeps QuickBar visible.

## Risk Register

1. Screen Recording permission missing:
   - Gate must surface an explicit permission error.
   - Do not substitute screenshots or terminal preview.

2. iTerm2 API unavailable:
   - App-window catalog may still return generic app targets with explicit iTerm2 catalog error.
   - iTerm2-pane stream is not complete until API proof exists.

3. Capture source cannot produce frames in CI/headless mode:
   - Unit tests may use injected fake capture deps only for daemon lifecycle.
   - Completion still requires live Mac pixel proof.

4. WebRTC/media transport appears connected but video is blank:
   - Selected route/candidate metadata is not success evidence.
   - Pixel/frame oracle is mandatory.

5. Resource leaks:
   - Every timer/capture/session/temp resource needs exactly-once cleanup tests.
   - Live gate records before/after owned resources and cleans by explicit marker or PID only.

6. Android receiver late events:
   - Closed overlay must ignore late frame/status and must not reopen.

## Test Plan

### White-Box Tests

- Protocol schema and message routing for start/status/error/stop/frame setup.
- Catalog readiness:
  - `session.state=connecting + WebSocket.OPEN` can request catalog.
  - No open physical socket surfaces `Remote window catalog transport is not open`.
- Stream state machine:
  - start success enters streaming.
  - capture start failure enters explicit error.
  - negotiation/setup timeout enters explicit error.
  - Back/minimize do not teardown.
  - close tears down exactly once.
- Android overlay:
  - selecting a target sends start-stream.
  - receiver attach displays real stream surface.
  - double tap or fullscreen button enters fullscreen.
  - Back/minimize return to floating.
  - close sends stop and restores shell.
  - late stream events cannot revive closed overlay.
- Daemon cleanup:
  - repeated close does not double-release.
  - stream error cleans timers/capture/transport.
- Negative gates:
  - terminal buffer preview path cannot satisfy streaming state.
  - screenshot/static/mock path cannot satisfy streaming success.
  - catalog partial success cannot be projected as stream success.
  - remote-window errors are not swallowed into empty success.
- Resource/function/mainline gates:
  - resource registry truth
  - function map/resource truth
  - mainline resource call map
  - feature registry
  - wiki/source consistency

### Black-Box Mac Gates

- Real daemon WebSocket catalog returns both app windows and iTerm2 panes when iTerm2 API is available.
- Crop rects are in bounds.
- A marked iTerm2 pane capture frame passes pixel oracle.
- A marked non-iTerm2 app-window capture frame passes pixel oracle.
- Capture source metadata records the real capture source and selected target.
- Cleanup leaves no marked temp window/session/stream process/timer/resource behind.

### Black-Box Android Gates

- Android picker lists daemon targets.
- Selecting a target starts the stream.
- Receiver gets real frames.
- Overlay pixel oracle sees the selected marker.
- Floating and fullscreen both render the frame with correct letterbox behavior.
- Close stops daemon capture and receiver lifecycle.

### Recommended Command Gates

```bash
pnpm --dir android exec vitest run \
  src/lib/remote-window-message-runtime.test.ts \
  src/lib/remote-window-overlay-runtime.test.ts \
  src/components/terminal/RemoteWindowOverlay.test.tsx \
  src/pages/TerminalPage.remote-window-overlay.test.tsx \
  src/contexts/session-context-remote-window-runtime.test.ts \
  src/contexts/session-context-socket-message-runtime.test.ts \
  --reporter dot

pnpm --dir android exec vitest run \
  src/server/remote-window-stream-daemon.test.ts \
  src/server/terminal-message-runtime.test.ts \
  --reporter dot

pnpm --dir android run test:feature-registry -- --reporter dot
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
git diff --check
```

Live gates:

- daemon WebSocket catalog/capture smoke
- Mac capture pixel oracle
- transport setup proof with route metadata
- Android/ADB receiver smoke
- Android rendered pixel oracle

APK gate after video proof:

```bash
pnpm --dir android run build:android
```

Then report versionName, versionCode, APK path, sha256, and install/public-update evidence when applicable.

## Implementation Steps

1. Reconfirm current memory and maps:
   - MemoryPalace search for remote-window stream and WebRTC/capture notes.
   - Read resource map/registry, function map, mainline call map/source, test design, and decision doc.
   - Record the exact owner, allowed/forbidden paths, mainline call IDs, and required gates for this run.

2. Fill architecture/test gaps:
   - Add any missing resource entries for media/capture/RTC if needed.
   - Add missing mainline call edges with `binding pending`.
   - Extend test design before implementation.

3. Add protocol and red/green unit tests:
   - Start/status/error/stop and receiver setup messages.
   - Message routing and error projection.
   - Negative tests for fake/screenshot/buffer paths.

4. Add daemon stream lifecycle:
   - Inject capture/transport deps for deterministic tests.
   - Implement start/stop/error/cleanup.
   - Add exact cleanup tests.

5. Add real Mac capture path:
   - Implement native capture helper or binding using the declared capture source.
   - Validate app-window and iTerm2-pane crop manifests.
   - Add live pixel oracle script/gate.

6. Add Android receiver/render path:
   - Start stream from overlay target selection.
   - Attach receiver surface.
   - Render floating/fullscreen.
   - Keep Back/minimize/close semantics correct.

7. Run focused automated gates.

8. Run live daemon and Android gates:
   - Reuse existing daemon/iTerm2/tmux/ADB resources.
   - Create only marked temporary resources.
   - Clean resources with explicit marker/PID/service-scoped cleanup.

9. Update notes and durable docs:
   - Append verified findings to `android/note.md`.
   - Promote stable verified truth to `android/MEMORY.md`.
   - Re-mine MemoryPalace with `scripts/mempalace-mine-zterm.sh`.
   - Search a unique phrase to prove retrievability.

10. Build APK only after real-video proof:
   - Build Android package.
   - Report package path and hash.
   - Install or publish update only when required and verified.

## Done Definition

The goal is done only when all of the following are true:

- Real Mac capture frames reach Android remote-window overlay.
- Pixel oracle proves selected source marker equals rendered receiver output.
- iTerm2 pane and generic app-window targets are covered or explicitly blocked with platform evidence.
- The stream lifecycle has positive and negative tests.
- Close cleanup is proven in tests and live gate.
- Architecture docs/maps/tests are synchronized.
- Required automated gates pass.
- APK is built only after the real video gates pass and is reported with version and sha256.
