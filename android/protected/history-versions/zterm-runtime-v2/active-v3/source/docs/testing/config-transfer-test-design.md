# Config Transfer Test Design

## Feature

- `feature_id`: `settings.config_transfer`
- Owner: `src/hooks/useConfigExport.ts`
- UI projection owners: `src/pages/SettingsPage.tsx`, `src/components/settings/AppUpdateSection.tsx`, `src/App.tsx`

## Lifecycle

1. Settings export action calls `useConfigExport.exportConfig`.
2. The hook snapshots local configuration keys and writes one file at `zterm-config-export/zterm-config.json`.
3. Export returns an explicit `{ ok: true, path, uri? }` or `{ ok: false, error }`.
4. App must surface that result to the user with a visible success or failure message.
5. Import reads the same canonical file path, validates schema, applies storage, and returns an explicit result before App reloads.
6. Runtime/session state is not configuration: `SESSION_GROUPS`, `OPEN_TABS`, `ACTIVE_SESSION`, page state, drafts, and command/history state must not be exported as config. After import, session options are discovered from the imported servers by connecting/refetching daemon/tmux truth.
7. App update manifest URL source is owned by `app-update-runtime`: `user-saved` remains authoritative, while `relay-injected` may replace stale private/server-connected update URLs when Relay settings change.
8. Settings projects update route candidates from the current Relay public `wsHostUrl` plus saved/direct daemon addresses. Selecting a route writes only the app-update preference draft source (`relay-injected` or `server-connected`) and does not mutate server/relay connection truth.

## White-Box Plan

- `src/hooks/useConfigExport.test.tsx` proves export returns a visible path/uri result, import failures return explicit errors, and session/runtime storage keys are excluded from config export.
- `src/components/settings/AppUpdateSection.test.tsx` proves Settings exposes the config transfer actions and route buttons mark daemon shortcuts as `server-connected` and Relay public route shortcuts as `relay-injected`, rather than converting them into explicit `user-saved` custom URLs.
- `src/pages/SettingsPage.theme.test.tsx` proves a configured Relay account produces a Relay public update candidate alongside direct daemon candidates, so update checking is not pinned to a Tailscale/private daemon address.
- `src/lib/app-update.test.ts`, `src/lib/app-update-relay-manifest.test.ts`, and `src/lib/app-update-runtime.test.ts` prove private legacy daemon URLs are replaceable by Relay, Relay URLs preserve the `/relay/updates/latest.json` route, and explicit `user-saved` URLs are not overwritten.

## Module Black-Box Plan

- Export button must not be console-only or silent boolean success.
- Import button must not swallow missing/invalid file errors.
- Exported server configs are enough for the receiving app to discover available tmux sessions; exporting stale session history/open tabs would create false local runtime truth.
- Relay login must not leave the updater pinned to a stale Tailscale/private manifest URL unless the user explicitly saved a custom URL after the source field existed.
- A device with both direct/Tailscale and Relay settings must be able to select the Relay public update route from Settings without deleting or rewriting direct saved server entries.

## Known Gaps

- Android scoped-storage permission behavior still requires packaged-device smoke before claiming real-device config file visibility.
