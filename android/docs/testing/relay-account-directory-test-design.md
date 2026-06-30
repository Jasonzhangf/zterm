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
  - applies user priority as weight only.
  - expires stale route TTL.
  - returns explainable diagnostics for selected and rejected candidates.
- `src/lib/traversal/route-health-cache.test.ts`
  - stores success/failure with TTL.
  - keys health by account + daemon + endpoint candidate id.
  - does not leak route health across users or daemon hostIds.

## Module Black-Box Plan

- `src/lib/connections-server-groups.test.ts`
  - relay directory machine appears in Connections without `BridgeServerPreset`.
  - sessions from directory are openable.
  - local preset only overrides display/pin/auth alias and cannot erase directory truth.
- `src/lib/session-picker.test.ts`
  - relay device resolves from directory endpoints when no preset exists.
  - selected target contains daemon identity and route candidates.
- `src/components/tmux/TmuxSessionPickerSheet.test.tsx`
  - login directory snapshot displays machines and tmux sessions.
  - Connect uses directory-derived target and selected route.
  - stale/error states are visible.
- `src/pages/ConnectionsPage.test.tsx`
  - remote machine card shows online/offline, session count, route badge, RTT/last error when available.
- `src/pages/ConnectionPropertiesPage.test.tsx`
  - Settings/connection edit no longer forces bridge preset as relay connectivity prerequisite.

## Project Black-Box / Smoke

- `scripts/traversal-relay-local-smoke.ts`
  - register/login.
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
- Positive: direct candidate with lower RTT wins.
- Negative: auth-failed direct candidate cannot win over relay.
- Positive: relay RTC wins when direct candidates are unreachable.
- Negative: relay RTC does not remain selected after fresh direct candidate wins by score.

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
  src/lib/connections-server-groups.test.ts \
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
