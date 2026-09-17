# Terminal Session Drawer Gesture Test Design

## Scope

- Feature: `terminal.session_drawer`
- Resources: `resource.ui_projection -> resource.open_tab -> resource.active_session`; fixed-width crop gestures also border `resource.renderer_window` but must not mutate terminal content truth.
- Owner: `src/components/terminal/TerminalSessionDrawer.tsx` for drawer intent; `src/pages/TerminalPage.tsx` for page-level projection and host canonicalization; `src/lib/server-identity.ts` for endpoint-to-daemon alias resolution; `src/App.tsx` only wires saved/Home server identity inputs into the page.
- Change class: physically remove cross-gesture selection, keep the session list content-sized with bounded scrolling, separate fixed-width crop pan from drawer open, ensure remote catalog row selection materializes and projects the selected session on the first tap, and make the drawer panel's capture-phase left swipe close the drawer even when the gesture starts inside the scrollable list. The edge swipe that opens the drawer may expose rows under the release point, but that same gesture must never become a row-selection intent. In `mirror-fixed`, right-side or middle horizontal drags belong to renderer crop pan; the drawer may only start from the left edge and only emit the `previous` drawer-open direction.
- Shell theme projection: the drawer consumes the effective terminal shell skin from its parent and uses the same background, surface, border, text, muted-text, active, pressed, and accent tokens as Header and QuickBar. Light, blue, and black skins may differ in palette, but a drawer must not retain hard-coded blue text/surfaces while another skin is active.
- Android back contract: Settings and connection properties retain back-to-Home navigation. On the terminal page, the system back/left-edge exit intent is consumed so it cannot terminate the app while the same edge is reserved for the session drawer gesture.

## Architecture Mapping

- Feature: `terminal.session_drawer` + shared `client.ambient_controls` presentation.
- Change class: UI projection only. No session/transport/daemon/mirror/sparse-buffer/renderer truth is introduced, mutated, or bypassed.
- Owner:
  - `TerminalSessionDrawerContent.tsx`: drawer/backdrop presentation and close intent.
  - `TerminalPage.tsx`: page-level drawer projection and existing `onClose` wiring.
  - `AmbientInput.tsx`: shared checkbox geometry under `client.ambient_controls`.
- Resource relation: `resource.ui_projection -> resource.open_tab -> resource.active_session`; `resource.session_drawer_ui_contract` supplies the typed drawer slot rendered by `resource.ui_projection`. `resource.renderer_window` is only an adjacent crop/gesture boundary and is not consumed or mutated by this change.
- Allowed paths: `src/components/terminal/TerminalSessionDrawerContent.tsx`, `src/components/terminal/TerminalSessionDrawer.tsx`, `src/components/terminal/TerminalSessionDrawer.test.tsx`, `src/components/ambient/AmbientInput.tsx`, `src/components/ambient/ambient-controls-render.test.tsx`, and this test design.
- Forbidden paths: daemon, tmux, transport, mirror store, client sparse buffer, renderer truth, session catalog refresh, session switching, and terminal content mutation.
- Positive gates: full-stage backdrop closes the drawer on terminal-area click; checkbox stays `18x18`; drawer close preserves the active session and does not request refresh.
- Negative gates: backdrop must not inherit a compact button height; dismiss must not mutate transport/session or trigger catalog refresh; checkbox must not inherit the settings field `width:100%` / `minHeight:44px`.

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
14. Production Relay directory may expose only `relay-rtc`, but a Session catalog is not daemon identity evidence. A direct SessionGroup may bind to an rtc-only Relay daemon only when a saved/Home endpoint alias already maps that exact endpoint to the daemon; the catalog may then confirm rows, never invent the host binding. A persisted stale daemon identity may be replaced only by one exact online endpoint match or one saved/Home endpoint alias whose daemon is currently online. A currently online daemon identity is never replaced. Missing or conflicting stable identity evidence remains separate instead of guessing from common Session names.
15. A Relay directory or saved/Home alias update must invalidate the memoized TerminalPage identity projection so the open drawer re-canonicalizes without a page restart.
16. If direct/Tailscale history and Relay history both resolve to the same canonical daemon, the drawer must enumerate each tmux session name exactly once. Route candidates and close/open intent metadata may merge, but duplicate history sources must not create duplicate rows.
17. Short session catalogs size the list to its rows and place the footer directly after the list. Long catalogs may shrink the list and scroll inside it, but the list must not use growing flex space that creates a large blank band above the footer.
18. The drawer is a tmux-only projection. Legacy persisted Herdr groups normalize to tmux and merge with the same canonical daemon/session identity; equal session names produce one row, while remote catalog target identity (`daemonHostId`/session name) remains unchanged.
19. While the drawer is open it is the only terminal chrome interaction layer: portrait status/back/settings controls, debug overlays, copy menus, and the fixed quickbar must not render above it. The drawer backdrop and panel must sit above the normal terminal chrome stack, while transient toast/progress feedback may remain above the drawer.
19. The narrow drawer header must remain one compact control row. It must not expose a preview-selection command or count, and must not stack tutorial/help copy over terminal or session content. At the 187px maximum drawer width, header controls stay on one line and session rows use a 56px minimum height with a 13px single-line title and 10px single-line subtitle; body text reserves space for trailing row actions and ellipsizes instead of wrapping or colliding with them.
20. The long-press session menu must expose both the existing slot assignment intent and an explicit hide intent; hiding stores the trimmed exact `sessionName` in the client-only `hiddenSessionNames[]` list, and the drawer projects only non-hidden rows.
21. The header restore-all action appears only while the hidden list is non-empty and clears that list through the same Settings persistence path.
22. A left swipe that starts anywhere inside the drawer panel, including the scrollable tree, closes the drawer once when horizontal displacement dominates vertical displacement and crosses the close threshold. Vertical list scrolling, row selection, and the close button must not emit a close intent.
23. While the drawer is open, its backdrop covers the full terminal stage outside the drawer panel. A real click or tap on the visible terminal area closes the drawer through the backdrop; a compact button style must not shrink the backdrop hit area to its content height.

## Paired Tests

- Positive: a press beginning on an available drawer row followed by click selects exactly that session.
- Positive: keyboard/accessibility click (`detail=0`) still selects the row.
- Positive: selecting a remote-only catalog row calls the session-open owner, consumes the returned materialized `sessionId`, and renders that Session in the center viewport after the parent supplies it.
- Positive: a direct/Tailscale session group matching a Relay directory endpoint appears under the Relay daemon host rail with its real session count.
- Positive: a saved/Home server mapping aliases an IP group into the matching daemon rail when production Relay exposes only `relay-rtc`.
- Positive: an rtc-only Relay daemon plus a saved/Home endpoint-to-daemon alias projects the direct group into the daemon rail, with the catalog supplying rows only.
- Negative: a pointer click delivered after drawer open without a matching row press does not select any session.
- Positive: long-press on a drawer row opens the session menu and the hide action removes the exact session name from the visible projection.
- Positive: restore-all appears only while hidden names exist and restores all hidden rows through the existing Settings config.
- Positive: a horizontal-dominant left swipe beginning inside the scrollable tree closes the drawer once.
- Positive: a click on the full-stage backdrop outside the drawer panel closes the drawer.
- Negative: the backdrop must not inherit a compact button height that leaves most of the terminal area outside its hit target.
- Negative: a vertical-dominant list scroll does not close the drawer.
- Negative: hiding `zterm-3` must not hide `zterm-30`; matching is exact trimmed session-name equality.
- Negative: an unavailable row remains non-selectable even after a matching press.
- Negative: arming one row cannot authorize selection of another row.
- Negative: selecting a remote-only catalog row must not switch or render the remote catalog placeholder id when no materialized `sessionId` is returned.
- Negative: the matching direct endpoint must not remain as a duplicate IP host rail with the Relay daemon rail showing zero sessions.
- Positive: direct/Tailscale and Relay history for one canonical daemon merge into one row per tmux session while retaining the Relay-capable open target.
- Negative: two history records for the same canonical daemon/session must not render two rows, emit duplicate React keys, or require source-specific selection.
- Negative: a unique Relay daemon catalog containing the same common Session name but no endpoint/alias identity evidence must not merge a direct or stale group into that daemon.
- Positive: a stale persisted daemon identity with one exact online Relay endpoint or saved/Home endpoint alias to an online daemon projects under that online daemon and does not create a second unreachable host rail.
- Negative: a currently online daemon identity is preserved, and a stale identity without endpoint/alias ownership remains separate even when exactly one online catalog contains the same Session names.
- Negative: `mirror-fixed` right-side horizontal drag does not emit drawer/tab swipe.
- Negative: `mirror-fixed` rightward pan with positive renderer offset changes the offset but does not emit drawer/tab swipe, including a start inside the left edge band.
- Negative: `mirror-fixed` zero-offset non-left-edge right pan stops before the parent drawer gesture owner, even though the visual offset cannot move further.
- Negative: `mirror-fixed` left-edge left swipe does not switch to next tab.
- Positive: `mirror-fixed` left-edge right swipe at renderer offset zero still emits drawer-open intent.
- Positive: a short drawer catalog uses `flex: 0 1 auto` with `min-height: 0`, keeping the footer adjacent to the final row.
- Negative: the session list must not use `flex: 1` or another grow rule that turns unused drawer height into blank list space.
- Positive: opening the drawer leaves one compact header row and keeps the drawer panel above the normal terminal chrome z-index ceiling.
- Positive: at the 187px drawer width, the header controls remain on one row and session rows keep the compact 56px height, 13px title, 10px subtitle, and ellipsized single-line text contract.
- Negative: portrait status/back/settings controls, debug overlay, copy menu, fixed quickbar, and instructional header paragraphs do not remain visible while the drawer is open.
- Negative: opening the drawer must not request a host-session catalog refresh, mutate `lastOpenedAt`, or reorder the existing host/session projection.
- Positive: a catalog update produced independently by the background owner may update the next drawer projection without coupling refresh work to drawer entry.

## Black-Box Impact

- Opening the drawer while `zterm` is active and a stale persisted tab such as `routecodex2` exists must leave both persisted and runtime active session ids on `zterm`.
- A background catalog refresh may mark the stale tab missing, but opening the drawer itself must not refresh, start its transport, change `lastOpenedAt`, reorder rows, or project its error banner.
- Selecting a remote-only catalog row must not freeze the old visible center terminal while the new transport connects. The first tap must produce the same visible target that a second tap on the newly materialized live row would have produced.

## Required Gates

- `src/components/terminal/TerminalSessionDrawer.test.tsx`
- `src/hooks/useAppPageState.test.tsx`
- `src/components/terminal/TerminalTabSwipeSurface.test.tsx`
- `src/pages/TerminalPageStageShell.pane-stage.test.tsx`
- `src/pages/TerminalPage.session-drawer.test.tsx`
- `src/lib/server-identity.test.ts`
- `src/hooks/useOpenTabRuntime.test.tsx`
- `src/contexts/session-context-session-runtime.test.ts`
- `src/contexts/session-context-transport-open-runtime.test.ts`
- `test:feature-registry`
- Android typecheck
- Android packaged real-device smoke: active `zterm` -> repeatedly edge-open/close drawer without catalog refresh or row reorder -> active remains `zterm`; no `routecodex2` transport/banner.

## Current Evidence

- `2026-09-17` candidate `0.1.3.3008` / `versionCode=1100030080`, APK sha256 `11ac61c4789d899ec7b62ce2920a4664330d6e58bf9ac7c7b59a546f88b0f801`; the debug APK and `update-dist/zterm-0.1.3.3008.apk` hashes match `update-dist/latest.json`.
- Android typecheck passed. Focused render tests passed `80/80`; `test:feature-registry` passed `104/104`.
- `pnpm --dir android run daemon:mirror:close-loop` passed all nine cases (`codex-live`, `top-live`, `vim-live`, `initial-sync`, `local-input-echo`, `long-input-echo`, `external-input-echo`, `daemon-restart-recover`, `schedule-fire`) at `2026-09-17T10:55:47.889Z`. `strict-audit.json` is `ok=true`; every case has `daemonCompare=true`, `clientCompare=true`, `stepsOk=true`, `compactWire=true`, plus the applicable `headReceived` / `bufferSyncReceived` or input-refresh checks. Each case contains the tmux oracle, daemon payload, `client-mirror-comparison.json`, and `source-and-client-render` step verification under `android/evidence/daemon-mirror/2026-09-17/`.
- Installed with `adb -s emulator-5554 install -r`; package data remained at `dataDir=/data/user/0/com.zterm.android` with `firstInstallTime=2026-09-08 06:36:23`.
- WebView smoke on the installed candidate: two consecutive portrait drawer open -> terminal-area click -> close rounds returned `data-state=closed` / `aria-hidden=true`; the overlay rect was `{x:0,y:0,w:800,h:1280}` and the terminal-area hit target was `terminal-session-drawer-overlay`. The active session remained `routecodex-1` and no catalog refresh or row reorder occurred.

## Known Gap

- JSDOM can model the synthetic click contract but cannot prove Android WebView's real touch-to-click ordering. L5 device replay is mandatory before closure.
