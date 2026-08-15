# Terminal Session Preview Test Design

## Lifecycle

`drawer-normal -> drawer-preview-selecting -> shell-preview-ready -> preview-open -> preview-replacement-menu -> preview-open -> shell`

- Selection is ordered client projection truth, maximum six.
- Selection storage remains open-session truth. A remote-only drawer catalog row is selectable only by first materializing it through the existing drawer remote-open owner; the stored target must be the returned local `sessionId`, not the `remote:<owner>::session:<name>` placeholder.
- Preview entry/exit preserves active session and existing transports.
- Selected sessions join live body demand while preview is open. Foreground/background lifecycle does not close preview or rewrite that projection; the dedicated background handoff owner may suppress body transfer and clear/restore live demand only after its configured keepalive window.
- Tile activation first projects the target into the focused session-group viewport, emits one explicit active-session intent, then exits. The visible shell session and input/live session must never diverge.
- Preview entry captures the current active session plus focused session-group projection. System Back is a cancel intent: it closes preview and restores that exact entry projection without selecting a preview tile.
- Long-pressing one preview tile opens a replacement menu containing only currently open, unselected sessions. Replacement preserves the selected tile's order and persists through the selection owner.
- Preview geometry is a pure projection through the shared `WindowGroupLayout` module: portrait uses a child rail above a large primary pane, landscape uses a child rail beside a large primary pane, every selected Session remains in its own preview container, child tap/click from the title or body only promotes the primary preview, and primary title/body click is the only activation path into the full terminal shell.
- Visual order badges must not be rendered inside tile titlebars; order can remain as data/ARIA/test metadata, but it must not consume the title layout.
- Secondary child previews use compact local terminal typography for glanceability and disable WebView text autosizing so the requested thumbnail scale is preserved. This is renderer projection only: no resize, width-mode, viewport callback, tmux geometry, or daemon mirror change is allowed.
- The primary preview keeps the normal live follow renderer with full ANSI cell/cursor DOM. Secondary previews remain real-time projections of their own buffer-store snapshots but use a passive theme-colored row projection: they reuse the shared row/cell style resolver, coalesce adjacent equal-style cells into runs, and do not create cursor DOM, run interactive follow/scroll realignment, input focus, textarea, or unthrottled resize loops. Promotion transfers the single primary full renderer role to the selected child.
- A selected secondary preview has no interactive renderer viewport. When its accepted live `buffer-head` advances, the buffer owner must request one terminal-height tail window from the exact session channel; non-live sessions without a viewport must not trigger that body pull.
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
- A short background/foreground round trip keeps preview mode, primary selection, ordered child selection, and the projected live session id set unchanged.
- Resolve portrait and landscape primary-plus-children layout for every supported selection count from one through six.
- Remove one preview target, persist the remaining order, and recompute geometry; removing the final target cancels preview.
- Secondary tile body tap promotes that tile to primary without activating the real shell; child body render-store updates continue before and after promotion.
- Secondary titlebar tap has the same promotion semantics; tapping the promoted primary titlebar or body emits one full-shell activation.
- Tile titlebars render session identity without visible ordinal badges.
- Secondary previews use smaller local font/row-height than the primary preview while remaining `mirror-fixed` and callback-inert.
- Exactly one preview tile uses primary live rendering; all secondary tiles use passive tail projection while still reflecting later buffer-store publications.
- A live secondary preview without a renderer visible range receives a bounded tail bootstrap after head advancement; the equivalent non-live session remains body-pull silent.
- Six-window source-to-DOM proof must remain below the deterministic preview DOM node budget. Secondary previews use one row node plus style-run spans, not one span per cell; block/shade glyphs keep distinct runs because their background depends on the exact glyph.
- Passive secondary preview rows must preserve ANSI fg/bg/flags through the shared `terminalCellStyle()` resolver and must not fall back to plain theme-foreground text or a second color parser.

## White-Box Negative

- Reject selection seven and duplicate targets.
- Exclude stale, unmaterialized remote placeholders, and reused-id targets whose host/tmux identity differs from persisted selection.
- If remote materialization returns no local session id, expose an explicit error and do not write a placeholder target.
- Reject middle, left-edge, vertical, short, and wrong-direction preview gestures.
- Preview must not call input, resize, width-mode, connect, reconnect, or active-session mutation on entry/exit.
- `visibilitychange` and foreground state alone must not close preview, drop child live ids, or make those ids newly visible on resume; this prevents routine resume from scheduling every child as a reconnect candidate.
- Secondary previews must not start interactive follow, focus, hidden-input, or unthrottled resize work merely because their buffer revision changes.
- Preview exit without tile activation must not change the focused session-group slot or active session.
- Invalid persisted JSON must return explicit failure.
- Reject replacement when the source target is absent or the replacement target is already selected.
- Long-press replacement must not also emit tile activation; ordinary tap must not open the replacement menu.
- System Back outside preview must not be consumed by the preview owner.
- Never pad a partial selection to six visual slots or fixed rows; group layout may change primary/child arrangement but must keep every selected Session as exactly one child container.
- Tile close must not activate or close the Session. Body pan/scroll must not activate the tile, trigger preview exit, or emit terminal mutation callbacks; only a tap/click without movement may promote or activate through the tile owner.

## Module Black-Box

- Drawer normal row tap switches; selection mode row tap only toggles checkbox.
- Drawer preview mode checkbox itself is an actionable selection command; tapping its visible hit target adds/removes through the same selection owner and never switches the Session.
- Drawer preview mode accepts remote catalog rows by calling the existing remote-open owner in background materialize mode, then toggling the returned local open-session target.
- Long-press slot assignment and close controls do not toggle preview selection.
- Left-edge right swipe opens drawer, middle horizontal swipe remains fixed crop, right-edge left swipe opens preview.
- Portrait uses a top child rail plus large primary preview and landscape uses a side child rail plus large primary preview; child tile tap from title or body promotes only the preview primary, primary tile tap updates the focused shell projection and switches once; close removes only the preview target; body drag scrolls/pans locally without activation; long press opens an unselected-session replacement menu; Back/right swipe cancels and restores the entry shell projection.
- After removing any preview tiles, the inline add command lists every currently open, eligible Session absent from the preview, excludes every still-selected Session, and can append one back without closing or switching a Session.

## Project Black-Box

Use up to six existing controlled tmux sessions. Automatically compare, per session:

`tmux source -> daemon mirror -> client sparse/render store -> preview tile DOM`

Cases: unique static markers, concurrent tail append, large multi-line replacement, fast header refresh, fast bottom prompt/input refresh, alternate-screen TUI refresh, cross-session isolation, exit/re-enter latest truth.

## Performance

- Preview open: at most six selected body subscriptions after dedupe.
- Preview close restores the normal body subscription set. A short background interval keeps the set stable while body transfer is suppressed; only the dedicated delayed background handoff may clear and later restore it.
- Record WebView CPU, frame time, DOM nodes, render cadence, transport bytes.
- No screenshot, stale cache, payload trimming, or per-frame storage write is permitted.

## Required Gates

- L0 resource/feature/function/mainline/wiki gates, typecheck, diff check.
- L1 selection/gesture/live-set/render positive and negative tests.
- L1 includes `TerminalView.test.tsx` passive-preview DOM/RAF guards and `TerminalPreviewGrid` interaction/render-truth tests.
- L2 real daemon/tmux source comparison.
- L3 client body-subscription integration without transport recreation.
- L3 must start from six already-connected mux channels where only the active channel has body demand. Opening preview must subscribe all five passive channels, request a bounded tail after each first head, and publish each returned body into its own render-store snapshot. A seventh non-selected channel must remain unsubscribed and body-pull silent.
- L3 must also close one inactive mux channel while leaving its physical target socket open, then add that Session to preview demand. The transport lifecycle owner must reopen only that logical channel with `bodySubscribed=true`, preserve the active Session, and keep exactly one physical target socket.
- L4 drawer/gesture/grid/DOM black-box.
- L5 standard APK build, update manifest/hash, unlocked foreground device smoke.

## Current Binding Status

- Selection, gesture, temporary live-set projection, and shared-renderer preview owners exist.
- `TerminalPreviewGrid.render-truth.test.tsx` automatically compares six independent immutable render-store snapshots with the corresponding preview DOM before and after a concurrent refresh.
- Real tmux source -> daemon mirror -> client sparse buffer -> preview DOM replay remains a required L2/L3 gate; the component test does not substitute for it.
- `pnpm run terminal:preview:source-dom-gate` owns the local automatic L2/L3 chain. It uses six explicitly named gate sessions, reuses them when already present, removes only sessions created by that invocation, asserts exactly six physical subscribers while open, and asserts the daemon subscriber count returns exactly to baseline after close.
