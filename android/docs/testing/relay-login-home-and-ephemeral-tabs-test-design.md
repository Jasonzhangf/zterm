# Relay Login Home And Ephemeral Tabs Test Design

## Scope

- `relay.directory_ui` owns the Android home projection for the fixed relay service.
- `terminal.open_tabs` owns in-process open Session state only. Open tabs and active-tab focus are not durable configuration.
- The terminal drawer remains the live Session projection. The home page must not project or manage Session groups.

## Lifecycle

1. Cold launch opens the home page with the fixed service identity `relay.codewhisper.cc`.
2. The user provides account and password; the client sends login to `https://relay.codewhisper.cc/relay/`.
3. A successful login stores token/account/directory truth, updates bridge relay settings, and starts the existing account device stream.
4. The home page projects daemon devices only. Session discovery and Session actions remain in the terminal drawer/picker.
5. Open tabs exist only for the current app process. A reload/cold launch starts with no tabs and does not restore `OPEN_TABS`, `ACTIVE_SESSION`, or saved tab lists.

## White-Box Positive

- The default relay URL resolver returns exactly `https://relay.codewhisper.cc/relay/`.
- Home login calls the relay account owner with the fixed URL plus the entered account/password.
- Successful login emits the returned `TraversalRelayClientSettings` to the App bridge-settings owner.
- Relay account persistence retains token/account/directory truth but never retains the plaintext login password.
- Runtime open/close/switch still updates the in-memory open-tab projection during the current process.

## White-Box Negative

- No editable relay host/base-URL field exists on the home page.
- Home does not import or invoke `connections-server-groups`, Session-group selection, Session open, Session close, or tab-list save/load owners.
- Cold bootstrap ignores and removes legacy `OPEN_TABS`, `ACTIVE_SESSION`, and `SAVED_TAB_LISTS` storage.
- Runtime tab changes do not write those storage keys.
- Logout clears relay account/bridge relay settings without touching daemon Session truth.

## Module Black-Box

- Render the signed-out home, submit credentials, and assert fixed-domain login and explicit busy/error states.
- Render the signed-in home and assert account identity plus online/offline daemon device rows, with no Session child rows or group controls.
- Exercise logout and assert the account owner and App relay-settings owner are both cleared.
- Mount open-tab runtime with stale legacy storage and prove startup remains empty and legacy keys are removed.

## Project Black-Box

- Build/install APK on an online Android device.
- Cold start: home shows the fixed relay service and only account/password inputs.
- Login with a real relay account after DNS is configured; verify account device stream and daemon rows appear.
- Open multiple Sessions through the terminal drawer, terminate/relaunch the app, and prove no tabs are restored.

## Known External Gate

- `relay.codewhisper.cc` must resolve to the deployed relay ingress before real login can pass. Until DNS and TLS ingress are live, local tests may prove request construction only, not production authentication.
