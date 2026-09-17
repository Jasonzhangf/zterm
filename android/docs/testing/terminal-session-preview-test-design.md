# Terminal Session Preview Test Design

## Lifecycle

`drawer-normal -> preview-open -> preview-slot-menu -> preview-open -> shell`

- Preview lattice is coordinate-keyed client projection truth. Each coordinate stores at most one target, and one session cannot occupy two coordinates.
- The focus coordinate is preview-session state only and is not persisted.
- Lattice storage remains open-session truth. A remote-only drawer catalog row is selectable only by first materializing it through the existing drawer remote-open owner; the stored target must be the returned local `sessionId`, not the `remote:<owner>::session:<name>` placeholder.
- Preview entry/exit preserves active session and existing transports.
- Visible populated cells join live body demand while preview is open. Foreground/background lifecycle does not close preview or rewrite that projection; the dedicated background handoff owner may suppress body transfer and clear/restore live demand only after its configured keepalive window.
- Clicking a populated non-focus edge cell pans the focus coordinate by one cell. It must not switch the active shell session or move any session target.
- Preview entry captures the current active session plus focused session-group projection. System Back is a cancel intent: it closes preview and restores that exact entry projection without selecting a preview tile.
- Long-pressing one populated edge cell opens a coordinate-scoped menu that can clear the cell or assign another currently open, unassigned session. Clicking an empty/stale `+` cell opens the same set menu. Long press must suppress the synthetic click.
- Preview geometry is a pure projection through `resolveJunctionPreviewLayout`: portrait shows focus + one side strip + top/bottom strips, landscape shows two center panes + top/bottom strips, and wide/tablet shows focus + left/right/top/bottom strips.
- All populated cells render full-size through the read-only shared renderer and are clipped by the viewport edge; empty/stale cells render `+`. No scale transform or thumbnail parser is allowed.
- The drawer remains reachable by a left-edge right swipe while preview is open. Drawer selection replaces only the focus-cell target and leaves every other coordinate unchanged.
- Preview focus pan and cell edits are renderer projection only: no resize, width-mode, viewport callback, tmux geometry, daemon mirror, transport, or reconnect change is allowed.
- Preview bodies accept local vertical scroll and horizontal fixed-width crop while remaining input/resize/viewport inert.

## White-Box Positive

- Set, clear, persist, and resolve coordinate-keyed open sessions.
- Select a remote-only drawer row in preview mode, materialize it without activation/navigation, and persist only the returned open-session target.
- Project normal live ids union visible populated cell ids while preview is open.
- Admit a leftward swipe beginning in the right-edge band.
- Render every tile from its own immutable render-store snapshot.
- Pan focus from one populated cell to another without changing lattice ownership or active shell session.
- Replace only the focus-cell target from the drawer and preserve every other coordinate.
- Android system Back closes preview and restores the entry active session and session-group projection.
- A short background/foreground round trip keeps preview mode, lattice coordinates, focus, and the projected live session id set unchanged.
- Resolve portrait, landscape, and wide junction geometry from one pure function.
- Set and clear one coordinate without moving another coordinate; stale cells resolve as empty.
- Empty and stale cells render `+`; populated visible cells render through the shared renderer.
- Visible populated cells without an interactive renderer viewport receive a bounded tail bootstrap after head advancement; non-visible cells remain body-pull silent.
- Source-to-DOM proof compares each visible populated cell's immutable render-store snapshot with its clipped preview DOM.

## White-Box Negative

- Reject duplicate coordinates, malformed targets, and assigning one session to a second coordinate.
- Exclude stale, unmaterialized remote placeholders, and reused-id targets whose host/tmux identity differs from persisted lattice target.
- If remote materialization returns no local session id, expose an explicit error and do not write a placeholder target.
- Reject middle, left-edge, vertical, short, and wrong-direction preview gestures.
- Preview must not call input, resize, width-mode, connect, reconnect, or active-session mutation on entry/exit.
- `visibilitychange` and foreground state alone must not close preview, drop child live ids, or make those ids newly visible on resume; this prevents routine resume from scheduling every child as a reconnect candidate.
- Preview cells must not start interactive follow, focus, hidden-input, or unthrottled resize work merely because their buffer revision changes.
- Preview exit must not change the focused session-group slot or active session.
- Invalid persisted JSON must return explicit failure.
- Reject clearing or setting an invalid coordinate; long-press menu must not also pan focus.
- System Back outside preview must not be consumed by the preview owner.
- Never pad visible cells or create sessions for stale coordinates.
- Edge-cell pan must not activate or close a Session. Body pan/scroll must not move focus, trigger preview exit, or emit terminal mutation callbacks.

## Module Black-Box

- Drawer normal row tap switches. While preview is open, drawer row tap replaces only the focus-cell target and never switches the active shell session.
- Drawer accepts remote catalog rows by calling the existing remote-open owner in background materialize mode, then assigning the returned local open-session target to the focus cell.
- Left-edge right swipe opens drawer, middle horizontal swipe remains fixed crop, right-edge left swipe opens preview.
- Portrait uses focus + one side strip + top/bottom strips, landscape uses two center panes + top/bottom strips, and wide/tablet uses focus + left/right/top/bottom strips. Edge-cell tap pans focus; empty `+` and long press open coordinate-scoped set/clear; body drag scrolls/pans locally without focus movement; Back/right swipe cancels and restores the entry shell projection.

## Project Black-Box

Use up to six existing controlled tmux sessions. Automatically compare, per session:

`tmux source -> daemon mirror -> client sparse/render store -> preview tile DOM`

Cases: unique static markers, concurrent tail append, large multi-line replacement, fast header refresh, fast bottom prompt/input refresh, alternate-screen TUI refresh, cross-session isolation, exit/re-enter latest truth.

## Performance

- Preview open: at most the visible populated cell count for the current form after dedupe (portrait/landscape 4, wide 5).
- Preview close restores the normal body subscription set. A short background interval keeps the set stable while body transfer is suppressed; only the dedicated delayed background handoff may clear and later restore it.
- Record WebView CPU, frame time, DOM nodes, render cadence, transport bytes.
- No screenshot, stale cache, payload trimming, or per-frame storage write is permitted.

## Required Gates

- L0 resource/feature/function/mainline/wiki gates, typecheck, diff check.
- L1 lattice/layout/gesture/live-set/render positive and negative tests.
- L1 includes `TerminalView.test.tsx` passive-preview DOM/RAF guards and `TerminalPreviewGrid` interaction/render-truth tests.
- L2 real daemon/tmux source comparison.
- L3 client body-subscription integration without transport recreation.
- L3 must start from at least six already-connected mux channels where only the active channel has body demand. Opening preview must subscribe only the visible populated lattice cells, request a bounded tail after each first head, and publish each returned body into its own render-store snapshot. A non-visible channel must remain unsubscribed and body-pull silent.
- L3 must also close one inactive mux channel while leaving its physical target socket open, then add that Session to preview demand. The transport lifecycle owner must reopen only that logical channel with `bodySubscribed=true`, preserve the active Session, and keep exactly one physical target socket.
- L4 drawer/gesture/grid/DOM black-box.
- L5 standard APK build, update manifest/hash, unlocked foreground device smoke.

## Current Binding Status

- Lattice, layout, gesture, temporary visible-cell live-set projection, and shared-renderer preview owners exist.
- `TerminalPreviewGrid.render-truth.test.tsx` automatically compares six independent immutable render-store snapshots with the corresponding preview DOM before and after a concurrent refresh.
- Real tmux source -> daemon mirror -> client sparse buffer -> preview DOM replay remains a required L2/L3 gate; the component test does not substitute for it.
- `pnpm run terminal:preview:source-dom-gate` owns the local automatic L2/L3 chain. It uses explicitly named gate sessions, reuses them when already present, removes only sessions created by that invocation, asserts only the visible populated cells are body-demand subscribers while open, and asserts the daemon subscriber count returns exactly to baseline after close.
