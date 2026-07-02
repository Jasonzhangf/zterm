# Connection Config Share Test Design

## Feature

- `feature_id`: `connections.config_share`
- Owner: `packages/shared/src/connection/connection-config-share.ts`
- UI projection owners: `src/components/tmux/TmuxSessionPickerSheet.tsx`, `src/pages/ConnectionPropertiesPage.tsx`, `src/pages/ConnectionsPage.tsx`
- Storage owner for import: `packages/shared/src/react/use-host-storage.ts`

## Lifecycle

1. Export starts from an existing `EditableHost` / `Host` connection truth.
2. Shared owner normalizes bridge endpoint fields and builds one canonical payload.
3. Shared owner encodes the payload into one canonical link.
4. QR code, copy link, and paste/deep-link import must all consume the same canonical link payload.
5. Import parses the link or raw encoded payload and returns an explicit success host or explicit error.
6. UI import must call host storage `upsertHost`; pages must not write `localStorage` directly.
7. Manual paste import, QR image scan import, and saved-connection sharing are exposed behind the real FAB / add-connection sheet (`TmuxSessionPickerSheet`); the main Connections list only owns the add intent and must not render a permanent import panel.

## White-Box Plan

- `packages/shared/src/connection/connection-config-share.test.ts` covers canonical payload build, app link, web link, raw encoded payload import, endpoint normalization, secret stripping, malformed input, unsupported URL, and invalid host identity.
- `src/components/tmux/TmuxSessionPickerSheet.test.tsx` proves the real FAB/add-flow sheet exposes paste import, QR image scan entry, saved-connection share selection, canonical share link, and QR rendering.
- `src/pages/ConnectionPropertiesPage.test.tsx` proves the secondary form page QR/link UI is rendered from `buildConnectionConfigShareLink(...)`; QR must not build a second payload format.
- `src/pages/ConnectionsPage.test.tsx` proves the main list does not render a permanent import box and only delegates to the FAB add intent.
- `src/lib/connection-config-share-android-truth.test.ts` proves the native `zterm://connection/import` intent filter and `appUrlOpen` handler delegate to the same parser and `upsertHost` import action.

## Module Black-Box Plan

- Connection form/page export tests prove a saved connection can show/copy a link and render a QR projection from the same link.
- Add-flow import tests prove successful paste import delegates to the app import owner.
- Error tests prove malformed links are shown as explicit import errors, not ignored and not converted into empty host state.

## Project Black-Box Impact

- This feature belongs to Connections / Storage. It must not touch daemon, terminal transport, buffer manager, renderer, or tmux mirror truth.
- It intentionally does not export `password`, `privateKey`, or `lastConnected`.
- It may include daemon endpoint, session name, relay identity, transport mode, auth token, tags, pinned flag, and auto command because those are connection import semantics.

## Known Gaps

- Current automated slice gates shared contract, UI projection, paste import, App deep-link wiring, native manifest parse, and TypeScript.
- Physical scan/open still requires Android packaged-device smoke before claiming real-device end-to-end completion.
