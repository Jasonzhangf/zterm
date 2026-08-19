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

## 2026-08-09 Dual-Stream Completion Plan (RWDS-20260809-A)

### Objective

Finish the approved dual-stream remote-window design: a persistent low-rate overview composite stream at a fixed 1920x1080 canvas, an independent focus stream, immediate overview crop on thumbnail selection, and focus projection commit only after the matching first-frame ready control event.

### Acceptance criteria

1. Catalog enumeration works on the installed daemon and returns real app/window targets without Swift type errors.
2. Composite overview capture starts, emits real frames, and remains alive while focus target updates occur.
3. The focus stream updates by monotonically increasing revision; stale result, wrong target, wrong stream, error, and close results cannot commit.
4. On 15t-1 the observed sequence is: overview frames -> selected overview crop -> focus accepted -> focus first-frame ready -> focus committed, with no black gap or fake success.
5. A second thumbnail selection while the first is pending proves the earlier ready result is rejected.
6. Real app-window and iTerm2/multi-window targets are tested where the platform permits; permission/capture limitations remain explicit errors with evidence.
7. Architecture registries, function/mainline maps, test design, notes, installed daemon, APK, and live evidence all describe the same implementation.
8. Final codex review runs only after all gates, installation/restart, and live verification pass.

### Scope and boundaries

In scope: `client.remote_window_dual_stream_switch`, shared typed focus control messages, daemon focus revision/ready owner, overview crop projection, fixed overview canvas contract, composite ScreenCaptureKit startup and frame delivery, and the remote-window-specific tests/live gates.

Out of scope: terminal mirror/buffer/renderer, unrelated session heartbeat regressions, relay redesign, broad cleanup of pre-existing dirty files, and any fallback from failed composite capture to a fake or single-stream success.

### Design and implementation

- Client state and projection owner: `android/src/lib/remote-window-dual-stream-runtime.ts` plus `RemoteWindowOverlay.tsx`.
- Control owner: `packages/shared/src/connection/protocol.ts`, `remote-window-message-runtime.ts`, `terminal-message-runtime.ts`.
- Capture/media owner: `remote-window-stream-daemon.ts`, `remote-window-capture.ts`, and `remote-window-scripts.ts`.
- Control payload must remain separate from media frames. Required fields are `requestId`, `streamId`, `revision`, `targetId`, and `phase`.
- `ready` is emitted only after a real focus frame for the accepted revision. It is not inferred from capture-source update completion, WebRTC connection state, or UI state.
- The current live blocker is the first divergence after catalog success: the overview composite ScreenCaptureKit process exits before producing a frame. Debug this as one hypothesis per experiment, with positive and reverse checks recorded under `playground/`.
- Do not alter formal runtime again until the experiment identifies the unique capture owner and the fix design is recorded.

### Required files and evidence

- Canonical design: `android/docs/decisions/2026-08-09-remote-window-dual-stream-design.md`.
- Test design: `android/docs/testing/remote-window-dual-stream-test-design.md`.
- Registries/maps: `android/docs/resource-registry.json`, `module-registry.json`, `edge-registry.json`, `feature-registry.json`, `function-map.md`, `docs/wiki/mainline-call-map.json`, `docs/wiki/mainline-source.md`.
- Experiment records and screenshots: `android/playground/` only during diagnosis; promote verified facts to `android/note.md` and `android/MEMORY.md`.
- Preserve unrelated existing changes in `android/note.md`, `session-context-*` tests, `remote-window-catalog.ts`, and `x0.txt`–`x7.txt`.

### Verification matrix

| Layer | Required proof |
| --- | --- |
| Experiment | baseline, first divergence, one positive intervention, one reverse intervention, unique owner, candidate fix report |
| Unit/state | crop-before-commit, matching-ready commit, stale/error/close rejection, positive and negative cases |
| Protocol/message | typed control result reaches only the dual-stream owner; no payload metadata leakage |
| Daemon | overview survives focus update; revision ordering; first focus frame emits ready; cleanup is exact once |
| Architecture | type-check, feature/registry/function/mainline/import gates, diff check |
| Build | canonical Android build when its prebuild stack is green; otherwise report the unrelated blocking test explicitly and do not weaken it |
| Live | daemon install/restart, 15t-1 ADB loop, catalog/start/overview frame/crop/focus-ready/commit/stop, track identity and dimensions |
| Review | `codex-review` only after installed runtime equals verified source and live gates pass |

### Ordered execution

1. Read current maps, design, note, and installed/runtime truth; create a fresh playground experiment record.
2. Reproduce the overview composite process exit on 15t-1 and capture exact stderr/exit/target geometry.
3. Test one capture hypothesis at a time; run reverse intervention; update the design report with the unique owner.
4. After the approved fix design, implement only the capture owner change with explicit tests and no fallback.
5. Run state/protocol/daemon/UI tests, type-check, architecture gates, and build prerequisites.
6. Install daemon and APK as required; restart only the scoped daemon/app service; run the complete 15t-1 loop.
7. Save compact evidence, update `note.md` and `MEMORY.md`, re-mine/search MemoryPalace, then run codex review.

### Definition of done

Done means the 15t-1 live trace proves overview frame availability, immediate selected crop, matching focus first-frame ready, and high-quality commit; stale/error/close paths are proven not to commit; all required gates pass; installed versions match the reviewed source; and no unresolved composite-capture blocker remains.

## 2026-08-19 Architecture / UI / ABR / Gesture Remediation Plan

This section supersedes conflicting implementation details above for the remediation scope below. The canonical product boundary remains `docs/decisions/2026-07-19-remote-window-stream-truth.md`; implementation must also reconcile the canvas, multi-window UI, touch-input, dual-stream, registry, function-map, and mainline-call-map documents before runtime edits.

### Objective and acceptance criteria

Refactor `desktop.remote_window_stream` into independently owned client and daemon modules, remove duplicate layout truth and silent compatibility paths, improve the Android remote-control UI, replace fire-and-forget quality changes with an acknowledged adaptive-bitrate controller, and make touch/mouse gesture semantics deterministic.

Acceptance requires:

1. Daemon owns one typed canvas layout with monotonic `layoutGeneration`; Android consumes published rectangles and never recomputes macOS/canvas layout.
2. Active code depends only on active registry resources; current overview/focus resources are separated from future VideoToolbox design resources.
3. `RemoteWindowOverlay.tsx` becomes a thin composition/view surface; catalog, lifecycle, receiver, quality, projection, gesture, and debug ownership are separate.
4. Daemon gateway only routes typed requests; capture, layout, encoder quality, input, catalog, and stream lifecycle have independent owners.
5. SDP rewrite fallback and silent quality catches are physically removed; unsupported negotiation and quality application return typed errors.
6. Android UI uses at least 48x48 CSS-pixel hit targets for primary touch actions, valid non-nested interactive elements, clear icons/labels, fixed primary controls, an overflow sheet for secondary controls, and separate user status versus developer diagnostics.
7. A child-window close affordance cannot close the whole stream; it is removed until a typed remove-window operation exists, or it waits for daemon ACK before changing projection.
8. Quality control tracks `requested -> applied | rejected` by request/revision; stale ACK cannot commit, rejected/timeout updates are visible, and `lastApplied` changes only after matching acceptance.
9. ABR enforces one stream-group budget across focus and overview, uses delta WebRTC stats plus hysteresis, steps down quickly and restores gradually, never exceeds the user ceiling, and updates sender plus capture cadence without rebuilding capture, receiver, session transport, or coordinate truth.
10. Touch and mouse modes have separate state machines. Gesture classification locks for the pointer sequence; touch scroll never moves the cursor; mouse mode supports pointer down/move/up drag; pair-to-single transition depends on zoom and input mode; long press has one timer owner.
11. Automated positive/negative gates, installed daemon/runtime identity, online Android UI/input replay, controlled weak-network traces, resource cleanup, DSH Review PASS, targeted commit, and push all complete.

### Scope and boundaries

In scope:

- Remote-window resource/module/edge/function/mainline/test-design truth.
- Android remote-window controller, receiver, quality controller, projection/view, gesture arena, picker, toolbar, app/window switch UI, and diagnostics projection.
- Shared typed layout, quality request/result/error, stream-group budget, and input-mode contracts.
- Daemon catalog, stream session, layout, capture cadence, sender quality, focus/overview budget, input injection, negotiation failure, and exact cleanup.
- Focused unit/page/server tests, architecture gates, typecheck/build, installed Mac daemon, online Android, controlled network tests, and true target-event replay.

Out of scope:

- Terminal mirror, sparse buffer, renderer, tmux width, session transport redesign, Relay account redesign, unrelated file transfer, and unrelated UI polish.
- Screenshot, terminal buffer, stale canvas, SDP rewrite, extra transport, or stream restart as fallback.
- Public Relay OTA without Jason's explicit authorization.
- Removing or overwriting unrelated dirty worktree changes.

### Architecture and owner plan

Required client owners:

- `client.remote_window_controller`: picker, target lock, stream lifecycle, transactional handoff.
- `client.remote_window_receiver`: peer connection, tracks, playback, stats deltas.
- `client.remote_window_quality`: selected ceiling, network cap, requested/applied/rejected state, ABR decisions.
- `client.remote_window_gesture_arena`: touch/mouse pointer sequence and one long-press owner.
- `client.remote_window_projection`: floating/fullscreen/IME geometry only.
- `client.remote_window_view`: pure render and intent callbacks.
- `client.remote_window_debug_projection`: debug-only diagnostics.

Required daemon owners:

- `daemon.remote_window_gateway`: typed routing only.
- `daemon.remote_window_stream_session`: stream registry, lifecycle, exact cleanup.
- `daemon.remote_window_catalog`: app/window/iTerm catalog and cache.
- `daemon.remote_window_canvas_layout`: only layout builder and `layoutGeneration` owner.
- `daemon.remote_window_capture`: ScreenCaptureKit source, target update, cadence update.
- `daemon.remote_window_quality`: stream-group budget and sender/capture quality transaction.
- `daemon.remote_window_input`: focus verification and OS event injection.

Required contracts:

- `RemoteWindowCanvasLayoutV1`: generation, canvas size, focus target, source/canvas rectangles, z-order.
- Quality request/result: request id, revision, stream/group id, target id, requested config, accepted/applied config or typed error.
- Stream-group budget: group/focus/overview bitrate and FPS.
- Input mode: `direct-touch | mouse-emulation`; cursor policy is derived by the daemon input owner rather than optional behavior scattered across events.

Forbidden architecture:

- Android layout builder or macOS coordinate reconstruction.
- Active modules consuming `status: design` resources.
- UI component owning WebRTC, ABR retry, transport, or daemon coordinate truth.
- Daemon gateway containing layout, capture, encode, or input algorithms.
- Control/debug fields mixed into media or business payloads.
- Duplicate long-press, layout, quality, or input-policy implementations.

### UI and interaction plan

- Top bar: target identity, effective-quality/network chip, minimize/fullscreen, close.
- Fixed bottom dock: Touch/Mouse, keyboard, screenshot, More.
- More sheet: fill remote window, user bitrate ceiling, scroll tuning, user-readable stream state, developer diagnostics entry.
- Replace `[]`, `#`, `KB`, and bare `x/-` placeholders with shared SVG icons and accessible labels.
- Primary hit surfaces are at least 48x48; thumbnail destructive actions meet the same touch contract.
- Picker/app switch rows use sibling buttons, never nested interactive elements.
- User status reports route, requested/applied quality, RTT/loss/freeze summary, and downgrade reason; raw ids/rects remain developer-only.
- Add a short first-use gesture guide and persistent mode indicator without covering video.

### Adaptive bitrate plan

- Convert receiver counters to per-sample deltas; add bytes/frames/packet-loss throughput signals where available.
- Smooth throughput/RTT with EWMA; severe freeze/loss may downshift immediately, ordinary weakness requires consecutive samples.
- Use a bounded bitrate ladder and FPS ladder. Never exceed the user ceiling or route/network cap.
- Restore only after a stable 10-15 second window and climb one step at a time; enforce a minimum dwell/cooldown.
- Allocate one total budget across focus and overview. Under weak networks, overview must shrink before it can starve focus.
- Apply quality as one transaction to existing sender encodings and ScreenCaptureKit cadence. No sender encoding fabrication and no stream restart.
- Publish requested, applied, rejected, reason, and measured signals through typed control/debug resources.

### Gesture plan

Direct Touch:

- tap -> remote click;
- drag at 1x -> remote scroll with no cursor movement;
- drag while zoomed -> local pan;
- coherent two-finger vertical move -> remote scroll;
- opposite-axis two-finger move -> local pinch;
- double tap -> 1x/2x local zoom;
- long press -> one right click plus haptic.

Mouse Emulation:

- move -> pointer move;
- tap -> left click;
- hold/drag -> pointer down, pointer moves, pointer up;
- two-finger move -> wheel scroll;
- two-finger tap or explicit action -> right click.

State rules:

- `candidate -> scroll | pinch | drag | longPress` commits once and cannot change until the pointer sequence ends.
- First and later direct-touch scroll events share no-cursor semantics.
- Pair-to-single transition uses current mode and zoom truth; unzoomed direct touch cannot enter meaningless local pan.
- Pointer cancel, second-finger arrival, slop crossing, mode change, background, stream switch, and close cancel the one long-press timer deterministically.

### Primary file plan

Architecture/docs before runtime:

- `android/docs/resource-registry.json`
- `android/docs/module-registry.json`
- `android/docs/edge-registry.json`
- `android/docs/function-map.md`
- `android/docs/wiki/mainline-call-map.json`
- `android/docs/wiki/mainline-source.md`
- remote-window decisions and test designs

Expected runtime surfaces after registry approval:

- `packages/shared/src/connection/protocol.ts`
- current remote-window client/server files, split into the owners declared above
- `android/src/components/terminal/RemoteWindowOverlay.tsx`
- `android/src/pages/SettingsPage.tsx`
- focused client/page/server tests and live probes

Do not create final filenames or symbols before their module/resource/edge ownership is active in the registries.

### Risks and prevention

- Layout migration can misroute input: generation mismatch must fail closed; old and new layout paths cannot coexist.
- Refactor can break live media: preserve protocol-visible behavior with characterization tests before moving code.
- ABR can oscillate: use hysteresis, stepwise restore, dwell time, and deterministic clock tests.
- Dual streams can exceed budget: enforce group allocation, not two independent controllers.
- UI redesign can hide actions: portrait/landscape/IME/accessibility screenshots and hit-target tests are mandatory.
- Gesture races can duplicate events: one arena, one timer, sequence ids, positive/negative target-event replay.
- Existing dirty files belong to other work: use the required semantic claim and clean issue worktree; merge only the reviewed change set.

### Verification matrix

| Layer | Required proof |
| --- | --- |
| Registry/architecture | active/design consistency, unique layout builder, owned paths, real import/call edges, forbidden fallback/duplicate-owner red gates |
| Characterization | current catalog/start/dual-stream/input/cleanup behavior locked before refactor |
| Client unit/page | controller, receiver, quality ACK/stale/reject, view hit targets/a11y, Touch/Mouse gesture state machines, pair-to-single, first-scroll no-cursor |
| Daemon unit | negotiation error, no SDP rewrite, layout generation, group budget, sender/capture cadence transaction, explicit overview failure, exact cleanup |
| Build | focused tests, feature/registry gates, typecheck, Android build, diff check |
| Installed daemon | prepared/installed SHA equality, scoped restart, new PID/uptime, health, live catalog/video/quality/input/cleanup |
| Android live | installed APK identity, portrait/landscape/IME UI, repeated touch/mouse actions, visible effective quality, no hidden primary actions |
| Network live | bandwidth/RTT/loss/freeze steps, fast downshift, slow stepwise restore, group budget, no transport/receiver/capture rebuild |
| Input live | Android/CDP request, daemon accepted result, controlled AppKit file-backed OS event log, no touch-scroll cursor movement, real mouse drag |
| Review/delivery | DSH Review PASS after all live gates; any post-review code change invalidates evidence and requires rerun; targeted commit/push |

### Ordered implementation

1. Search MemoryPalace; read current note/MEMORY, resource/module/edge registries, function/mainline/verification maps, decisions, test designs, and live source.
2. Establish `.agent-collab` run/claim and one clean issue worktree under `playground/`; preserve current dirty main tree.
3. Write architecture mapping and update docs/registries/gates first. Separate active overview/focus truth from future encoder design resources.
4. Add characterization and red tests for duplicate layout, active-to-design dependencies, SDP fallback, quality ACK, first-scroll cursor policy, gesture lock, pair transition, mouse drag, invalid UI nesting, hit sizes, and child-close semantics.
5. Implement daemon-owned layout contract and remove client recomputation.
6. Split daemon and client owners without retaining old dual paths.
7. Implement UI hierarchy/accessibility changes.
8. Implement quality request/applied state machine, group-budget ABR, and dynamic capture cadence.
9. Implement deterministic Touch/Mouse gesture arenas and remove duplicate long-press ownership.
10. Run focused/full mapped gates, typecheck, build, architecture self-audit, and diff check in the clean worktree.
11. Handoff/merge the exact change set; install/restart the scoped daemon, verify installed SHA/PID/health, build/install Android without clearing data, and run online UI/network/input/resource-cleanup gates.
12. Run DSH Review with `opencode-go/deepseek-v4-flash`; fix and repeat all invalidated verification until semantic PASS.
13. Commit and push only the reviewed scope. Update note/MEMORY/skill if new reusable truth was proven; re-mine and search the zterm MemoryPalace wing.

### Definition of done

Done means all duplicate/forbidden runtime paths are physically removed; registries describe current active truth; one daemon layout generation drives video projection and input mapping; client and daemon owners are independently testable; UI is usable on real Android portrait/landscape/IME states; requested/applied quality is acknowledged and visible; controlled weak-network tests prove bounded fast-down/slow-up behavior and a focus/overview group budget without lifecycle rebuilds; Touch and Mouse modes pass deterministic automated and real OS-event replay; installed daemon/APK identities match reviewed source; required gates and DSH Review pass; exact cleanup, commit, and push are complete; and no P0/P1 finding remains open.
