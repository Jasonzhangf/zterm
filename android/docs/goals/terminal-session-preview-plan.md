# Terminal Session Quick Preview Plan

## 1. Goal And Acceptance

Add an Android terminal quick-preview mode:

- The existing session drawer gains an explicit preview-selection mode.
- Users can select 1 to 6 currently opened sessions in stable order.
- A leftward swipe starting from the terminal shell's right edge opens preview mode.
- Selection remains valid with any count from 1 through 6; preview never requires filling all six slots.
- Grid geometry derives from the resolved selection count: portrait uses at most 2 columns, landscape uses at most 3 columns, and rows are only created as needed while preserving selection order.
- Every tile displays the latest terminal body from the existing daemon mirror, client sparse buffer, and shared renderer truth.
- Preview is read-only. Tapping a tile exits preview and explicitly switches to that session.
- Long-pressing a tile opens an in-preview replacement menu listing currently open, unselected sessions; replacement preserves tile order.
- Each tile exposes a small close command that removes only that target from the persisted preview selection; it does not close the underlying Session. Removing the final tile cancels preview.
- Preview terminal bodies remain read-only but accept local vertical scroll and mirror-fixed horizontal pan without emitting input, resize, viewport, width, connect, or reconnect intents.
- Preview typography uses a smaller dedicated projection than the real Shell so each tile exposes more terminal content.
- Back or a rightward exit gesture cancels preview and restores the active/session-group projection captured at preview entry.

Acceptance requires automated source-to-preview DOM parity, gesture ownership tests, build gates, an upgrade APK, and unlocked real-device evidence. Unit tests or screenshots alone do not close the task.

## 2. Scope And Boundaries

### In Scope

- Drawer preview-selection mode and ordered selection state.
- Maximum-six validation and stale-selection handling.
- Right-edge preview-entry gesture and preview-exit gesture.
- Responsive 1-6 tile preview grid without empty reserved slots.
- Long-press in-place replacement from currently open, unselected sessions.
- System Back cancel with entry-session projection restoration.
- Read-only terminal preview projection using existing render truth.
- Temporary live body subscription for selected sessions while preview is open.
- Feature/resource/function/mainline/verification maps and architecture gates.
- Focused white-box, module black-box, project black-box, APK, and real-device verification.

### Out Of Scope

- Daemon mirror changes.
- WebSocket attach/reconnect redesign.
- tmux resize or adaptive-width changes.
- Sparse-buffer merge changes.
- Open-tab lifecycle changes.
- Replacement of the existing top/center/bottom session-group navigation.
- Previewing remote catalog sessions that do not have a current open-tab/render-buffer owner.
- Input, IME, copy mode, QuickBar, or file transfer interaction inside preview tiles.

## 3. Architecture Mapping

Create feature `terminal.session_preview`.

Resources:

- `resource.session_preview_selection`: client preference/projection truth containing an ordered maximum-six selection.
- `resource.session_preview_mode`: shell projection state (`closed`, `opening`, `open`, `closing`).
- Existing `resource.open_tab`: resolves selected identities to currently opened sessions.
- Existing `resource.client_sparse_buffer`: terminal body truth consumed read-only.
- Existing `resource.renderer_window`: shared renderer projection; preview cannot create a second parser or terminal-body truth.
- Existing `resource.ui_projection`: drawer and preview grid output.
- Existing `resource.active_session`: receives explicit switch intent only after a preview tile tap.

Required relations:

```text
resource.ui_projection
  -> resource.session_preview_selection
  -> resource.open_tab
  -> resource.client_sparse_buffer
  -> resource.renderer_window
  -> resource.ui_projection

preview tile tap
  -> resource.ui_projection
  -> resource.active_session
```

Forbidden relations:

- Preview UI -> daemon, tmux, backend session, or physical transport.
- Preview selection -> direct socket open/reconnect.
- Preview tile -> terminal input, resize, IME, copy, or width-policy writes.
- Preview mode -> arbitrary active-session mutation on enter/exit. The only exit writes are explicit tile activation or exact restoration of the captured entry projection on cancel.
- New ANSI/cell/cursor parser inside preview components.

Update these truth surfaces before implementation:

- `docs/resource-registry.json`
- `docs/resource-map.md`
- `docs/feature-registry.json`
- `docs/feature-gates.md`
- `docs/function-map.md`
- `docs/wiki/mainline-call-map.json`
- `docs/wiki/mainline-source.md`
- machine-generated wiki review surface

## 4. Interaction Contract

### Drawer

Normal mode remains unchanged:

- Row tap switches session.
- Long press opens the existing top/center/bottom slot menu.
- Close control closes the target session through the existing owner.

Preview-selection mode:

- Enter through a dedicated preview-selection icon in the drawer header.
- Every eligible row shows a checkbox and selection-order marker.
- Row tap only toggles preview selection; it never switches session.
- Selection seven is rejected with an explicit maximum-six message.
- Remote-only catalog rows are visibly ineligible until opened through the existing open-session flow.
- Footer exposes selected count, clear, and done commands.
- Closing an already selected open session removes it from selection through the selection owner.

### Gesture Ownership

Touch ownership is fixed at gesture start:

```text
left-edge right swipe   -> session drawer
middle horizontal swipe -> mirror-fixed renderer crop/pan
right-edge left swipe   -> session preview
```

- Preview admission band: one shared constant, initially 64 CSS px.
- Preview requires horizontal axis lock and a leftward threshold.
- Once preview owns the gesture, propagation to renderer crop and drawer owners stops for the entire sequence.
- Vertical, short, wrong-direction, and non-edge gestures do not open preview.
- Existing fixed-width left-edge drawer admission remains unchanged.

### Preview Mode

- Entering preview preserves current active session.
- Portrait: `columns = min(selected count, 2)` and `rows = ceil(selected count / columns)`.
- Landscape: `columns = min(selected count, 3)` and `rows = ceil(selected count / columns)`.
- Fewer than six sessions use only the rows required by the selected count, with no decorative or reserved empty terminal slots.
- Tile tap performs one explicit session switch, then exits preview.
- Tile long press opens the replacement menu and suppresses the release click; moving beyond the gesture threshold cancels long press and also suppresses activation.
- Replacement candidates are current open sessions not already selected; selecting one replaces the source tile in place and persists the ordered preference.
- The tile close command removes the selected preview target only. It must never call the Session close owner.
- When fewer than six tiles remain, the add command lists every currently open eligible Session not already in preview and appends the chosen target through the existing selection owner.
- Touching a terminal body may vertically scroll its local visible history or horizontally pan its mirror-fixed crop. The gesture must not activate the tile, open the replacement menu, exit preview, or mutate upstream terminal truth.
- Back/rightward exit restores the entry terminal/session-group projection without reconnect or buffer reset.
- Background transition closes only the preview projection and retains selection preference.
- Preview cannot open while IME owns the screen; the entry intent first closes IME through the existing owner or is explicitly rejected.

## 5. Render Design

Do not implement preview as screenshots, cached text, or a second renderer.

Extract/reuse one read-only terminal presentation surface from the existing renderer boundary:

```text
TerminalView
  -> shared TerminalRenderSurface
     interactive behavior enabled

TerminalPreviewTile
  -> same TerminalRenderSurface
     read-only preview policy
```

Preview policy:

- Consume immutable `SessionRenderBufferSnapshot` for the selected session.
- Render latest bottom-relative window.
- Disable input, DOM focus, IME, copy, resize, width-mode writes, and viewport writes. Permit only local read-side vertical scroll and mirror-fixed horizontal crop gestures.
- Preserve ANSI, CJK width, reverse, background spans, cursor metadata, and gap semantics from the shared renderer.
- Use a fixed internal render geometry and CSS scale/crop for the tile. Tile dimensions must not feed back into tmux or daemon geometry.
- Do not mount a normal interactive terminal and a preview terminal for the same session simultaneously.

## 6. State And Persistence

Add a versioned selection contract, owned outside `TerminalPage` orchestration:

```ts
interface SessionPreviewSelectionV1 {
  version: 1;
  orderedTargets: Array<{
    sessionId: string;
    daemonHostId?: string;
    bridgeHost: string;
    bridgePort: number;
    sessionName: string;
  }>;
}
```

Rules:

- Normalize to unique ordered targets, maximum six.
- Resolve only against current open-tab truth before projection.
- A missing target is stale, not a new-session or reconnect intent.
- Invalid/corrupt storage returns explicit failure and structured debug evidence; it cannot silently become a successful empty state.
- Selection persists; live subscriptions do not. Selected sessions join the live set only while preview is open.

## 7. Function Map And Mainline Call IDs

Required function-map bindings, with exact symbols filled only after source implementation exists:

- `terminal.session_preview.selection.normalize`
- `terminal.session_preview.selection.toggle`
- `terminal.session_preview.selection.persist`
- `terminal.session_preview.selection.resolve_open_tabs`
- `terminal.session_preview.gesture.begin`
- `terminal.session_preview.gesture.update`
- `terminal.session_preview.gesture.finish`
- `terminal.session_preview.live_set.project`
- `terminal.session_preview.grid.render`
- `terminal.session_preview.tile.activate`

Required mainline call IDs:

- `android_preview:SessionDrawer->PreviewSelectionOwner`
- `android_preview:PreviewSelectionOwner->OpenTabResolver`
- `android_preview:TerminalShellGesture->PreviewModeOwner`
- `android_preview:PreviewModeOwner->PreviewLiveSetProjector`
- `android_preview:PreviewLiveSetProjector->SessionBodySubscriptionIntent`
- `android_preview:PreviewModeOwner->TerminalPreviewGrid`
- `android_preview:TerminalPreviewGrid->TerminalPreviewTile`
- `android_preview:TerminalPreviewTile->SharedRenderSurface`
- `android_preview:TerminalPreviewTile->ActiveSessionIntent`

Every edge must bind adjacent caller/callee symbols, semantic input/output, owner feature, resource relation, canonical docs, and required gates. Unknown symbols remain `binding pending`; do not fabricate them.

## 8. Expected File Surface

Likely new owners:

- `src/lib/session-preview-selection.ts`
- `src/lib/session-preview-gesture.ts`
- `src/components/terminal/TerminalPreviewGrid.tsx`
- `src/components/terminal/TerminalPreviewTile.tsx`
- focused tests beside each owner

Likely integration points:

- `src/components/terminal/TerminalSessionDrawer.tsx`
- `src/pages/TerminalPage.tsx`
- `src/pages/TerminalPageStageShell.tsx`
- `src/components/TerminalView.tsx` only for extracting/reusing the unique render presentation boundary
- `src/lib/types.ts` only for shared contracts/storage keys

Exact paths and symbols must be confirmed against current source and maps before edits. Preserve unrelated dirty-worktree changes.

## 9. Test Plan

### White-Box Positive

- Ordered selection grows from one to six and persists deterministically.
- Closing a selected open session removes it.
- Preview-open live set equals normal visible sessions union selected sessions.
- Every tile reads its own immutable session snapshot.
- Tile activation emits exactly one explicit switch intent and exits preview.

### White-Box Negative

- Seventh selection is rejected.
- Duplicate and remote-only targets cannot enter resolved selection.
- Preview enter/exit does not mutate active session.
- Preview never calls input, resize, width-mode, connect, or reconnect owners.
- Invalid persistence is explicit failure.
- Background/foreground does not resume all selected sessions as active sessions.

### Module Black-Box

- Drawer normal mode and preview-selection mode remain isolated.
- Long-press slot assignment does not toggle preview selection.
- Close action does not select or switch rows.
- Left edge opens drawer, middle pan crops fixed terminal, right edge opens preview.
- Wrong-direction, vertical, short, and non-edge gestures are no-ops.
- Back/right swipe exits preview and restores normal shell.
- Portrait and landscape produce correct ordered grid geometry without overlap.

### Terminal Data Black-Box Gate

Use six controlled tmux sessions with unique markers and independent TUI refresh patterns:

1. Capture tmux/session source truth.
2. Observe daemon mirror revision/body for each session.
3. Observe client sparse-buffer snapshot for each session.
4. Read rendered preview DOM rows for each tile.
5. Automatically compare source -> daemon -> client -> preview DOM.

Required cases:

- Six unique static markers.
- Concurrent tail append.
- Large multi-line replacement.
- Top/status-line fast refresh.
- Bottom prompt/input fast refresh.
- Alternate-screen TUI refresh.
- Session isolation: session A body must never appear in session B tile.
- Exit/re-enter must show current truth, never a previous screenshot/cache frame.

### Performance And Lifecycle

- Preview closed returns to normal body-subscription/render cadence.
- Preview open has at most six selected body subscriptions plus required normal visible resources, with dedupe.
- Measure WebView CPU, frame time, DOM node count, render cadence, and transport bytes during six-session refresh.
- No per-frame localStorage writes.
- Performance failure must be fixed in the unique shared render/live-set owner; no screenshot or stale-cache fallback.

### Gate Ladder

- L0: resource/feature/function/mainline/wiki architecture gates, typecheck, diff check.
- L1: selection, gesture, live-set, render-surface positive/negative tests.
- L2: real daemon/tmux six-session source comparison.
- L3: client transport/runtime and body-subscription integration.
- L4: drawer, shell gesture, preview grid, renderer DOM black-box tests.
- L5: standard Android build, upgrade APK, unlocked foreground device gesture/data/performance smoke.

## 10. Implementation Order

1. Audit current worktree and active `.agent-collab` claims; claim `terminal.session_preview` resources and mainline nodes.
2. Add resource/feature/function/mainline/verification skeleton and architecture red gates.
3. Add test design and paired red tests before implementation.
4. Implement selection contract and persistence owner.
5. Implement drawer selection projection.
6. Implement right-edge gesture owner and three-zone arbitration.
7. Extract/reuse the unique read-only render presentation surface.
8. Implement preview grid and temporary live-set projection.
9. Run focused gates, full affected regression, typecheck, and architecture gates.
10. Run six-session daemon/client/preview automatic parity gate.
11. Build through the standard Android release script, publish upgrade APK, install when an online device is available, and run unlocked L5 smoke.
12. Update note/MEMORY/local skills only with verified reusable truth; re-mine the sanitized zterm corpus and verify searchability.
13. Review diff, precisely stage only owned changes, then commit after verification.

## 11. Risks And Controls

- Gesture collision: lock owner at touch start; paired positive/negative tests.
- Renderer duplication: shared render surface only; architecture scan forbids preview parser/cell projection.
- Bandwidth/heat: body subscription exists only while preview is visible; measure six-session live load.
- Viewport corruption: preview tile cannot emit resize or viewport writes.
- Cross-session contamination: automatic session-source-to-tile-DOM comparison.
- Dirty worktree: no checkout/reset; preserve and isolate existing changes.
- Remote-only session ambiguity: visibly ineligible until explicitly opened; no implicit socket creation.

## 12. Definition Of Done

- Drawer selects 1-6 open sessions with clear order and explicit maximum handling.
- Right-edge left swipe reliably opens preview without stealing left drawer or middle fixed crop gestures.
- Preview grid shows current terminal truth for every selected session through the shared renderer.
- Enter/exit does not recreate transport, reset buffer, resize tmux, or change active session.
- Tile tap explicitly switches to the selected session and exits.
- Positive/negative white-box tests pass.
- Gesture, drawer, lifecycle, and terminal-data black-box gates pass.
- Six-session real tmux/daemon/client/preview DOM comparison passes automatically.
- Standard Android build and update-channel manifest/hash verification pass.
- Unlocked real-device L5 evidence verifies selection, right-edge entry, live refresh, tile switch, exit, orientation, and acceptable performance.
- Maps, wiki, test design, project memory, and local skill remain synchronized.
- Owned changes are reviewed and committed without absorbing unrelated worktree changes.
