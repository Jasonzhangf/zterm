# Connection Config Share Test Design

## Feature

- `feature_id`: `connections.config_share`
- Owner: `packages/shared/src/connection/connection-config-share.ts`
- UI projection owners: `src/components/tmux/TmuxSessionPickerSheet.tsx`, `src/pages/ConnectionPropertiesPage.tsx`, `src/pages/ConnectionsPage.tsx`
- Storage owner for import: `packages/shared/src/react/use-host-storage.ts`

## Lifecycle

1. Export starts from all local `EditableHost` / `Host` connection truths plus local quick action / shortcut action configuration by default.
2. Shared owner normalizes bridge endpoint fields and shortcut config fields, then builds one canonical multi-config payload.
3. Shared owner encodes the payload into one canonical link.
4. QR code, copy link, and paste/deep-link import must all consume the same canonical link payload.
5. Import parses the link or raw encoded payload and returns explicit success hosts, quick actions, shortcut actions, or explicit error.
6. UI import must call host storage `upsertHost` for every parsed host and quick/shortcut storage owners for parsed shortcut config; pages must not write `localStorage` directly.
7. Manual paste import, QR image scan import, and saved-connection sharing are exposed behind the real FAB / add-connection sheet (`TmuxSessionPickerSheet`); the main Connections list only owns the add intent and must not render a permanent import panel.
8. In the real add sheet, default sharing scope is all saved connections plus shortcut configuration; single-connection sharing is only an optional narrowed scope and does not include shortcut configuration.

## White-Box Plan

- `packages/shared/src/connection/connection-config-share.test.ts` covers canonical multi-host plus shortcut-config payload build, app link, web link, raw encoded payload import, endpoint normalization, shortcut action normalization, secret stripping, malformed input, unsupported URL, and invalid host identity.
- `src/components/tmux/TmuxSessionPickerSheet.test.tsx` proves the real FAB/add-flow sheet exposes paste import, QR image scan entry, all-connections plus shortcut-config share by default, optional single-connection narrowed selection, canonical share link, and QR rendering.
- `src/pages/ConnectionPropertiesPage.test.tsx` proves the secondary form page QR/link UI is rendered from `buildConnectionConfigShareLink(...)`; QR must not build a second payload format.
- `src/pages/ConnectionsPage.test.tsx` proves the main list does not render a permanent import box and only delegates to the FAB add intent.
- `src/lib/connection-config-share-android-truth.test.ts` proves the native `zterm://connection/import` intent filter and `appUrlOpen` handler delegate to the same parser and `upsertHost` import action.

## Module Black-Box Plan

- Connection form/page export tests prove a saved connection can show/copy a link and render a QR projection from the same link.
- Add sheet export tests prove multiple saved connections and shortcut configuration are encoded into one default QR/link.
- Add-flow import tests prove successful paste import delegates to the app import owner.
- App deep-link import tests prove parsed shortcut configuration is written through `useQuickActionStorage` / `useShortcutActionStorage`.
- Error tests prove malformed links are shown as explicit import errors, not ignored and not converted into empty host state.

## Project Black-Box Impact

- This feature belongs to Connections / Storage. It must not touch daemon, terminal transport, buffer manager, renderer, or tmux mirror truth.
- It intentionally does not export `password`, `privateKey`, or `lastConnected`.
- It may include daemon endpoint, session name, relay identity, transport mode, auth token, tags, pinned flag, auto command, text quick actions, and terminal shortcut actions because those are configuration sync semantics.

## Known Gaps

- Current automated slice gates shared contract, UI projection, paste import, App deep-link wiring, native manifest parse, and TypeScript.
- Physical scan/open still requires Android packaged-device smoke before claiming real-device end-to-end completion.
