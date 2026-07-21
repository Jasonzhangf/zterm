# Relay Account Directory Test Design

## Scope

This test design covers:
- `relay.account_directory`
- `relay.route_selection`
- `relay.directory_ui`

Goal: logging into relay must synchronize account-scoped machines, daemon identities, endpoint candidates, tmux sessions, route health, and UI projections. A relay daemon must be openable from Connections / Session Picker even when no local bridge preset exists.

## Lifecycle Mainline

```text
daemon tmux truth
  -> daemon relay host client publishes directory-update
  -> relay server authenticates, persists account directory, broadcasts directory-snapshot
  -> Android relay account runtime stores directory snapshot
  -> Connections / Session Picker project machines and sessions
  -> route selector builds explicit candidates and probes/scored selection
  -> TraversalSocket opens selected route and reports selected diagnostics
```

## White-Box Plan

- `src/traversal-relay/store.test.ts`
  - persists directory endpoints and sessions per account.
  - migrates old device-only store into empty directory blocks.
  - rejects account cross-read and invalid daemon hostId.
  - daemon disconnect changes presence but preserves last published directory facts as stale.
- `src/traversal-relay/server.test.ts`
  - `GET /api/directory` requires auth and isolates users.
  - `/ws/host` accepts `directory-update` only from authenticated daemon.
  - device stream emits `directory-snapshot` after update.
  - invalid directory payload emits relay-error, not success-shaped empty directory.
  - `/updates/latest.json` and `/updates/<apk>` are served from the relay updates directory, preserving manifest `apkUrl` semantics and returning explicit 404 for missing assets.
- `src/server/relay-client.test.ts`
  - daemon host client sends directory-update after relay-ready.
  - tmux session read failure is reported explicitly.
  - endpoint candidates are omitted when config lacks the corresponding path.
- `src/lib/relay-account-directory.test.ts`
  - normalizes directory snapshots.
  - preserves endpoint/session semantics.
  - projects online daemon machines without local bridge preset.
- `src/lib/traversal/route-selector.test.ts`
  - selects reachable lowest-scored candidate.
  - rejects unreachable and auth-failed candidates.
  - applies the product Auto order rather than stale saved route priority.
  - logged-in daemon routes prefer direct/Tailscale websocket first, then `rtc-direct` WebRTC UDP candidate, then TURN-only `rtc-relay`.
  - expires stale route TTL.
  - returns explainable diagnostics for selected and rejected candidates.
- `src/lib/traversal/socket.test.ts`
  - exposes the selected WebRTC ICE pair as metadata-only diagnostics after `rtc-direct` or `rtc-relay` opens.
  - reports `rtc-direct/direct` only when the selected pair is non-TURN, and reports `rtc-relay/turn` when either selected candidate type is `relay`.
- `src/lib/traversal/route-health-cache.test.ts`
  - stores success/failure with TTL.
  - keys health by account + daemon + endpoint candidate id.
  - does not leak route health across users or daemon hostIds.

## Module Black-Box Plan

- `src/pages/ConnectionsPage.test.tsx`
  - fixed relay home logs into the account owner without an editable relay URL.
  - daemon devices from directory are projected without Session group controls.
  - Home does not open/close sessions or save tab lists.
- `src/lib/session-picker.test.ts`
  - relay device resolves from directory endpoints when no preset exists.
  - selected target contains daemon identity and route candidates.
- `src/components/tmux/TmuxSessionPickerSheet.test.tsx`
  - login directory snapshot displays machines and tmux sessions.
  - Connect uses directory-derived target and selected route.
  - stale/error states are visible.
- `src/hooks/useSessionOpenActions.test.tsx`
  - drawer host refresh / quick-new for an online Relay daemon with `relay-rtc` uses an explicit route-aware `transportMode='auto'` target and keeps direct LAN/Tailscale endpoints ahead of WebRTC direct and TURN.
- `src/pages/TerminalPage.session-drawer.test.tsx` + `src/contexts/session-context-session-runtime.test.ts`
  - a drawer row that is already open through stale direct/Tailscale identity is still routed through the session-open owner when the Relay catalog uniquely owns that daemon, and the existing local session is reused instead of duplicated.
- `src/pages/ConnectionsPage.test.tsx`
  - remote machine card shows online/offline, session count, route badge, RTT/last error when available.
- `src/pages/ConnectionPropertiesPage.test.tsx`
  - Settings/connection edit no longer forces bridge preset as relay connectivity prerequisite.

## Project Black-Box / Smoke

- `scripts/traversal-relay-local-smoke.ts`
  - register/login.
  - fetch relay `/updates/latest.json`, resolve the relative `apkUrl`, and download the same bytes from the relay route.
  - daemon connects to `/ws/host`.
  - daemon publishes `directory-update`.
  - client fetches `/api/directory`.
  - client receives `directory-snapshot` over `/ws/devices`.
  - route selector chooses a candidate.
  - selected route lists tmux sessions.

## Positive / Negative Pairing

- Positive: valid daemon update appears in directory.
- Negative: invalid update does not overwrite existing directory with empty success.
- Positive: online daemon without local preset is openable.
- Negative: offline daemon with stale route is shown stale and cannot be silently treated as fresh.
- Positive: private LAN IPv4 wins before Tailscale, WebRTC direct, and TURN/Relay when no route has recent health.
- Positive: Tailscale wins before public IPv4, WebRTC direct, and TURN/Relay by default.
- Positive: slow Tailscale can lose to WebRTC direct when RTT health proves direct is faster, but it must not jump straight to TURN/Relay.
- Negative: stale saved `traversalPathPriority` must not make Auto pick UDP or Relay before Tailscale.
- Negative: auth-failed direct/Tailscale candidates cannot win over a healthy later route.
- Positive: route plan contains candidates in product order `private LAN IPv4 -> Tailscale/direct websocket -> WebRTC direct -> TURN/Relay`; opened-route heartbeat/close failure records route health and lets the next attempt try another route.
- Negative: `rtc-direct` must not contain TURN credentials or use `iceTransportPolicy='relay'`; otherwise TURN would bypass direct/Tailscale routes.
- Negative: a legacy/global `wsUrl` override must not collapse a route-aware Host into a single WebSocket candidate; hosts with `relay-rtc`, `relayHostId` / `daemonHostId`, explicit `signalUrl`, or `transportMode='webrtc'` must still enter `TraversalSocket` with the full candidate plan.
- Positive: `rtc-direct/direct` diagnostics include selected ICE pair local/remote candidate type, address, port, protocol, and RTT when WebRTC stats expose them.
- Negative: app/debug UI must not infer P2P from `requestOrigin="relay-host"` or from stale `targetKey`; only `resolvedPath` plus selected ICE pair metadata can prove the actual route.
- Positive: TURN-only `rtc-relay` wins only after private LAN/Tailscale/direct websocket and WebRTC direct candidates are unavailable/unhealthy.
- Negative: TURN-only `rtc-relay` does not remain selected after a fresh direct candidate wins by score.
- Positive: drawer host actions for an online relay daemon use relay identity, build direct LAN/Tailscale, `rtc-direct`, and `rtc-relay` candidates, and still keep saved direct/Tailscale ahead of WebRTC/TURN.
- Negative: a saved direct/Tailscale preset for the same daemon must not make drawer refresh/open duplicate daemon rails or replace the relay daemon identity; it is only a route candidate.
- Positive: selecting an already-open stale direct row from a Relay-owned drawer catalog upgrades that session transport target to route-aware target truth and reuses the existing session id.
- Negative: selecting that row must not bypass the session-open owner with a raw `switchSession`, and must not create a second open tab for the same tmux session.

## Required Gates Before APK

```bash
pnpm --dir android exec vitest run \
  src/traversal-relay/store.test.ts \
  src/traversal-relay/server.test.ts \
  src/server/relay-client.test.ts \
  src/lib/relay-account-directory.test.ts \
  src/lib/traversal/route-selector.test.ts \
  src/lib/traversal/route-health-cache.test.ts \
  src/lib/traversal/config.test.ts \
  src/lib/traversal/socket.test.ts \
  src/lib/session-picker.test.ts \
  src/components/tmux/TmuxSessionPickerSheet.test.tsx \
  src/pages/ConnectionsPage.test.tsx \
  src/pages/ConnectionPropertiesPage.test.tsx

pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
pnpm --dir android exec tsx scripts/traversal-relay-local-smoke.ts
```

APK build and install-state validation are required after the automatic gates pass.

## Evidence Requirements

Write live verification evidence to:

```text
android/evidence/relay-directory/<YYYY-MM-DD>/
```

Minimum evidence:
- relay `/api/directory` response with account/device/session data redacted only for secrets.
- route diagnostics showing candidates, scores, selected route, rejected reasons.
- Android installed-state screenshot/log proving Connections / Session Picker can open a remote session without local bridge preset.

## Known Gaps

- Direct IPv6 / IPv4 reachability must be verified from the actual Android device route, not inferred from daemon reachability.
- TURN credential freshness is still relay server config truth; this test design only verifies propagation and selected route behavior.
- Existing `devices-snapshot` compatibility can remain during migration, but new UI completion requires `directory-snapshot` as the consumed truth.
