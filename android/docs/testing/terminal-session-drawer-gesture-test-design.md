# Terminal Session Drawer Gesture Test Design

## Scope

- Feature: `terminal.session_drawer`
- Resources: `resource.ui_projection -> resource.open_tab -> resource.active_session`; fixed-width crop gestures also border `resource.renderer_window` but must not mutate terminal content truth.
- Owner: `src/components/terminal/TerminalSessionDrawer.tsx` for drawer intent; `src/pages/TerminalPage.tsx` for page-level projection and host canonicalization; `src/lib/server-identity.ts` for endpoint-to-daemon alias resolution; `src/App.tsx` only wires saved/Home server identity inputs into the page.
- Change class: physically remove cross-gesture selection, keep the session list content-sized with bounded scrolling, separate fixed-width crop pan from drawer open, and ensure remote catalog row selection materializes and projects the selected session on the first tap. The edge swipe that opens the drawer may expose rows under the release point, but that same gesture must never become a row-selection intent. In `mirror-fixed`, right-side or middle horizontal drags belong to renderer crop pan; the drawer may only start from the left edge and only emit the `previous` drawer-open direction.

## Lifecycle

1. A terminal edge gesture starts outside the closed drawer.
2. The terminal swipe owner recognizes the gesture and opens the drawer.
3. Android WebView may synthesize a click at the gesture release coordinate after the drawer is visible.
4. The drawer must reject that click because no selection press started inside the drawer row.
5. A later real touch/mouse press that starts on a drawer row arms exactly that row and may select it.
6. Keyboard/accessibility activation remains valid without a pointer press.
7. In `mirror-fixed`, a right-side horizontal drag must not reach the drawer/tab swipe owner; a left-edge right swipe may open the drawer.
8. If the `mirror-fixed` renderer still has a positive horizontal offset, a rightward drag must first consume that offset and stop propagation even when it starts inside the drawer edge band.
9. If the renderer offset is already zero, a non-left-edge rightward horizontal drag still belongs to renderer crop ownership and must not bubble into drawer/tab swipe.
10. The drawer may receive a left-edge right swipe only after the renderer offset is already zero before that gesture starts.
11. A remote-only catalog row press emits one session-open owner intent. When the owner returns the materialized local `sessionId`, TerminalPage must immediately project that session into the focused session-group viewport slot.
12. After parent state includes the materialized Session, the visible center terminal must render that Session without requiring a second drawer tap. The page must not project the synthetic `remote:<owner>::session:<name>` catalog id as active truth.
13. Relay directory direct endpoints and saved/Home server mappings are identity aliases only: an IP-keyed direct Session/SessionGroup whose endpoint belongs to a Relay daemon must project into that daemon's canonical host rail, not create a second IP rail.
14. Production Relay directory may expose only `relay-rtc`. If no endpoint mapping exists, a direct SessionGroup may bind to a Relay daemon only when its non-missing Session names are all present in exactly one Relay daemon catalog. Zero or multiple matches remain separate instead of guessing.
15. A Relay directory or saved/Home alias update must invalidate the memoized TerminalPage identity projection so the open drawer re-canonicalizes without a page restart.
16. If direct/Tailscale history and Relay history both resolve to the same canonical daemon, the drawer must enumerate each tmux session name exactly once. Route candidates and close/open intent metadata may merge, but duplicate history sources must not create duplicate rows.
17. Short session catalogs size the list to its rows and place the footer directly after the list. Long catalogs may shrink the list and scroll inside it, but the list must not use growing flex space that creates a large blank band above the footer.

## Paired Tests

- Positive: a press beginning on an available drawer row followed by click selects exactly that session.
- Positive: keyboard/accessibility click (`detail=0`) still selects the row.
- Positive: selecting a remote-only catalog row calls the session-open owner, consumes the returned materialized `sessionId`, and renders that Session in the center viewport after the parent supplies it.
- Positive: a direct/Tailscale session group matching a Relay directory endpoint appears under the Relay daemon host rail with its real session count.
- Positive: a saved/Home server mapping aliases an IP group into the matching daemon rail when production Relay exposes only `relay-rtc`.
- Positive: an rtc-only Relay daemon catalog that uniquely contains every non-missing Session name aliases that direct group into the daemon rail.
- Negative: a pointer click delivered after drawer open without a matching row press does not select any session.
- Negative: an unavailable row remains non-selectable even after a matching press.
- Negative: arming one row cannot authorize selection of another row.
- Negative: selecting a remote-only catalog row must not switch or render the remote catalog placeholder id when no materialized `sessionId` is returned.
- Negative: the matching direct endpoint must not remain as a duplicate IP host rail with the Relay daemon rail showing zero sessions.
- Positive: direct/Tailscale and Relay history for one canonical daemon merge into one row per tmux session while retaining the Relay-capable open target.
- Negative: two history records for the same canonical daemon/session must not render two rows, emit duplicate React keys, or require source-specific selection.
- Negative: two Relay daemon catalogs containing the same direct-group Session names are ambiguous and must not be merged.
- Negative: `mirror-fixed` right-side horizontal drag does not emit drawer/tab swipe.
- Negative: `mirror-fixed` rightward pan with positive renderer offset changes the offset but does not emit drawer/tab swipe, including a start inside the left edge band.
- Negative: `mirror-fixed` zero-offset non-left-edge right pan stops before the parent drawer gesture owner, even though the visual offset cannot move further.
- Negative: `mirror-fixed` left-edge left swipe does not switch to next tab.
- Positive: `mirror-fixed` left-edge right swipe at renderer offset zero still emits drawer-open intent.
- Positive: a short drawer catalog uses `flex: 0 1 auto` with `min-height: 0`, keeping the footer adjacent to the final row.
- Negative: the session list must not use `flex: 1` or another grow rule that turns unused drawer height into blank list space.

## Black-Box Impact

- Opening the drawer while `zterm` is active and a stale persisted tab such as `routecodex2` exists must leave both persisted and runtime active session ids on `zterm`.
- Drawer catalog refresh may mark the stale tab missing, but must not start its transport and must not project its error banner.
- Selecting a remote-only catalog row must not freeze the old visible center terminal while the new transport connects. The first tap must produce the same visible target that a second tap on the newly materialized live row would have produced.

## Required Gates

- `src/components/terminal/TerminalSessionDrawer.test.tsx`
- `src/components/terminal/TerminalTabSwipeSurface.test.tsx`
- `src/pages/TerminalPageStageShell.pane-stage.test.tsx`
- `src/pages/TerminalPage.session-drawer.test.tsx`
- `src/lib/server-identity.test.ts`
- `src/hooks/useOpenTabRuntime.test.tsx`
- `src/contexts/session-context-session-runtime.test.ts`
- `src/contexts/session-context-transport-open-runtime.test.ts`
- `test:feature-registry`
- Android typecheck
- Android packaged real-device smoke: active `zterm` -> edge-open drawer -> catalog refresh -> active remains `zterm`; no `routecodex2` transport/banner.

## Known Gap

- JSDOM can model the synthetic click contract but cannot prove Android WebView's real touch-to-click ordering. L5 device replay is mandatory before closure.
