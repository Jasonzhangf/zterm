# Terminal Session Drawer Gesture Test Design

## Scope

- Feature: `terminal.session_drawer`
- Resources: `resource.ui_projection -> resource.open_tab -> resource.active_session`; fixed-width crop gestures also border `resource.renderer_window` but must not mutate terminal content truth.
- Owner: `src/components/terminal/TerminalSessionDrawer.tsx`
- Change class: physically remove cross-gesture selection and separate fixed-width crop pan from drawer open. The edge swipe that opens the drawer may expose rows under the release point, but that same gesture must never become a row-selection intent. In `mirror-fixed`, right-side or middle horizontal drags belong to renderer crop pan; the drawer may only start from the left edge and only emit the `previous` drawer-open direction.

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

## Paired Tests

- Positive: a press beginning on an available drawer row followed by click selects exactly that session.
- Positive: keyboard/accessibility click (`detail=0`) still selects the row.
- Negative: a pointer click delivered after drawer open without a matching row press does not select any session.
- Negative: an unavailable row remains non-selectable even after a matching press.
- Negative: arming one row cannot authorize selection of another row.
- Negative: `mirror-fixed` right-side horizontal drag does not emit drawer/tab swipe.
- Negative: `mirror-fixed` rightward pan with positive renderer offset changes the offset but does not emit drawer/tab swipe, including a start inside the left edge band.
- Negative: `mirror-fixed` zero-offset non-left-edge right pan stops before the parent drawer gesture owner, even though the visual offset cannot move further.
- Negative: `mirror-fixed` left-edge left swipe does not switch to next tab.
- Positive: `mirror-fixed` left-edge right swipe at renderer offset zero still emits drawer-open intent.

## Black-Box Impact

- Opening the drawer while `zterm` is active and a stale persisted tab such as `routecodex2` exists must leave both persisted and runtime active session ids on `zterm`.
- Drawer catalog refresh may mark the stale tab missing, but must not start its transport and must not project its error banner.

## Required Gates

- `src/components/terminal/TerminalSessionDrawer.test.tsx`
- `src/components/terminal/TerminalTabSwipeSurface.test.tsx`
- `src/pages/TerminalPageStageShell.pane-stage.test.tsx`
- `src/pages/TerminalPage.session-drawer.test.tsx`
- `src/hooks/useOpenTabRuntime.test.tsx`
- `src/contexts/session-context-session-runtime.test.ts`
- `src/contexts/session-context-transport-open-runtime.test.ts`
- `test:feature-registry`
- Android typecheck
- Android packaged real-device smoke: active `zterm` -> edge-open drawer -> catalog refresh -> active remains `zterm`; no `routecodex2` transport/banner.

## Known Gap

- JSDOM can model the synthetic click contract but cannot prove Android WebView's real touch-to-click ordering. L5 device replay is mandatory before closure.
