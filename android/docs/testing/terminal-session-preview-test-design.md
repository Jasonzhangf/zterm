# Terminal Session Preview Test Design

## Lifecycle

`drawer-normal -> drawer-preview-selecting -> shell-preview-ready -> preview-open -> preview-replacement-menu -> preview-open -> shell`

- Selection is ordered client projection truth, maximum six.
- Selection storage remains open-session truth. A remote-only drawer catalog row is selectable only by first materializing it through the existing drawer remote-open owner; the stored target must be the returned local `sessionId`, not the `remote:<owner>::session:<name>` placeholder.
- Preview entry/exit preserves active session and existing transports.
- Selected sessions join live body demand only while preview is open and foreground.
- Tile activation first projects the target into the focused session-group viewport, emits one explicit active-session intent, then exits. The visible shell session and input/live session must never diverge.
- Preview entry captures the current active session plus focused session-group projection. System Back is a cancel intent: it closes preview and restores that exact entry projection without selecting a preview tile.
- Long-pressing one preview tile opens a replacement menu containing only currently open, unselected sessions. Replacement preserves the selected tile's order and persists through the selection owner.
- Grid geometry is a pure projection of orientation plus the resolved 1-6 selection count: portrait caps each row at two tiles, landscape caps each row at three, and no empty row is reserved.
- Tile close removes only that preview selection; the underlying open Session remains untouched. The final removal cancels preview and restores its entry projection.
- Preview bodies accept local vertical scroll and horizontal fixed-width crop while remaining input/resize/viewport inert.

## White-Box Positive

- Add, remove, persist, and resolve 1-6 open sessions.
- Select a remote-only drawer row in preview mode, materialize it without activation/navigation, and persist only the returned open-session target.
- Project normal live ids union selected ids while preview is open.
- Admit a leftward swipe beginning in the right-edge band.
- Render every tile from its own immutable render-store snapshot.
- After tile activation, mount the real shell on the selected session and prove subsequent render-store publications continue updating that shell.
- Replace one selected target in place with an unselected open-session target and preserve all other target order.
- Android system Back closes preview and restores the entry active session and session-group projection.
- Resolve portrait and landscape columns/rows for every supported selection count from one through six.
- Remove one preview target, persist the remaining order, and recompute geometry; removing the final target cancels preview.

## White-Box Negative

- Reject selection seven and duplicate targets.
- Exclude stale, unmaterialized remote placeholders, and reused-id targets whose host/tmux identity differs from persisted selection.
- If remote materialization returns no local session id, expose an explicit error and do not write a placeholder target.
- Reject middle, left-edge, vertical, short, and wrong-direction preview gestures.
- Preview must not call input, resize, width-mode, connect, reconnect, or active-session mutation on entry/exit.
- Preview exit without tile activation must not change the focused session-group slot or active session.
- Invalid persisted JSON must return explicit failure.
- Reject replacement when the source target is absent or the replacement target is already selected.
- Long-press replacement must not also emit tile activation; ordinary tap must not open the replacement menu.
- System Back outside preview must not be consumed by the preview owner.
- Never exceed two portrait columns or three landscape columns; a partial selection must not be padded to six visual slots or fixed full-grid rows.
- Tile close must not activate or close the Session. Body pan/scroll must not activate the tile, trigger preview exit, or emit terminal mutation callbacks.

## Module Black-Box

- Drawer normal row tap switches; selection mode row tap only toggles checkbox.
- Drawer preview mode checkbox itself is an actionable selection command; tapping its visible hit target adds/removes through the same selection owner and never switches the Session.
- Drawer preview mode accepts remote catalog rows by calling the existing remote-open owner in background materialize mode, then toggling the returned local open-session target.
- Long-press slot assignment and close controls do not toggle preview selection.
- Left-edge right swipe opens drawer, middle horizontal swipe remains fixed crop, right-edge left swipe opens preview.
- Portrait uses at most two columns and landscape at most three, with rows derived from the selected count; tile tap updates the focused shell projection and switches once; close removes only the preview target; body touch scrolls/pans locally; long press opens an unselected-session replacement menu; Back/right swipe cancels and restores the entry shell projection.
- After removing any preview tiles, the inline add command lists every currently open, eligible Session absent from the preview, excludes every still-selected Session, and can append one back without closing or switching a Session.

## Project Black-Box

Use up to six existing controlled tmux sessions. Automatically compare, per session:

`tmux source -> daemon mirror -> client sparse/render store -> preview tile DOM`

Cases: unique static markers, concurrent tail append, large multi-line replacement, fast header refresh, fast bottom prompt/input refresh, alternate-screen TUI refresh, cross-session isolation, exit/re-enter latest truth.

## Performance

- Preview open: at most six selected body subscriptions after dedupe.
- Preview close/background: restore normal body subscription set.
- Record WebView CPU, frame time, DOM nodes, render cadence, transport bytes.
- No screenshot, stale cache, payload trimming, or per-frame storage write is permitted.

## Required Gates

- L0 resource/feature/function/mainline/wiki gates, typecheck, diff check.
- L1 selection/gesture/live-set/render positive and negative tests.
- L2 real daemon/tmux source comparison.
- L3 client body-subscription integration without transport recreation.
- L4 drawer/gesture/grid/DOM black-box.
- L5 standard APK build, update manifest/hash, unlocked foreground device smoke.

## Current Binding Status

- Selection, gesture, temporary live-set projection, and shared-renderer preview owners exist.
- `TerminalPreviewGrid.render-truth.test.tsx` automatically compares six independent immutable render-store snapshots with the corresponding preview DOM before and after a concurrent refresh.
- Real tmux source -> daemon mirror -> client sparse buffer -> preview DOM replay remains a required L2/L3 gate; the component test does not substitute for it.
- `pnpm run terminal:preview:source-dom-gate` owns the local automatic L2/L3 chain. It uses six explicitly named gate sessions, reuses them when already present, removes only sessions created by that invocation, asserts exactly six physical subscribers while open, and asserts the daemon subscriber count returns exactly to baseline after close.
