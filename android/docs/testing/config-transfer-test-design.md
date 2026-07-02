# Config Transfer Test Design

## Feature

- `feature_id`: `settings.config_transfer`
- Owner: `src/hooks/useConfigExport.ts`
- UI projection owners: `src/components/settings/AppUpdateSection.tsx`, `src/App.tsx`

## Lifecycle

1. Settings export action calls `useConfigExport.exportConfig`.
2. The hook snapshots local configuration keys and writes one file at `zterm-config-export/zterm-config.json`.
3. Export returns an explicit `{ ok: true, path, uri? }` or `{ ok: false, error }`.
4. App must surface that result to the user with a visible success or failure message.
5. Import reads the same canonical file path, validates schema, applies storage, and returns an explicit result before App reloads.
6. Runtime/session state is not configuration: `SESSION_GROUPS`, `OPEN_TABS`, `ACTIVE_SESSION`, page state, drafts, and command/history state must not be exported as config. After import, session options are discovered from the imported servers by connecting/refetching daemon/tmux truth.

## White-Box Plan

- `src/hooks/useConfigExport.test.tsx` proves export returns a visible path/uri result, import failures return explicit errors, and session/runtime storage keys are excluded from config export.
- `src/components/settings/AppUpdateSection.test.tsx` proves Settings exposes the config transfer actions.

## Module Black-Box Plan

- Export button must not be console-only or silent boolean success.
- Import button must not swallow missing/invalid file errors.
- Exported server configs are enough for the receiving app to discover available tmux sessions; exporting stale session history/open tabs would create false local runtime truth.

## Known Gaps

- Android scoped-storage permission behavior still requires packaged-device smoke before claiming real-device config file visibility.
