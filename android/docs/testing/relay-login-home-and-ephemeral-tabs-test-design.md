# Relay Login Home And Ephemeral Tabs Test Design

## Scope

- `relay.directory_ui` owns the Android home projection for the fixed relay service as an optional route/sync surface.
- `connections.history_projection` owns saved direct/Tailscale connection history; Home may project it but must not make Relay its owner.
- `terminal.open_tabs` owns in-process open Session state only. Open tabs and active-tab focus are not durable configuration.
- The terminal drawer remains the live Session projection. The home page must not project or manage Session groups.

## Lifecycle

1. Cold launch opens the home page with saved direct/Tailscale connections and the fixed Relay service identity `relay.codewhisper.cc`.
2. Relay logged-out state is not a navigation gate: saved connections, active in-process Sessions, and the add-connection action remain visible.
3. The user may provide account and password; the client sends login to `https://relay.codewhisper.cc:18443/relay/`.
4. A successful login stores token/account/directory truth, updates bridge relay settings, starts the existing account device stream, and adds synchronized route/device candidates.
5. Relay account directory can augment connection candidates, including Tailscale/local/direct endpoints, but it must not delete, replace, or hide direct saved-host truth.
6. The home page projects active runtime Sessions and saved connections only as entry points. Session discovery and Session actions remain in the terminal drawer/picker.
7. Open tabs exist only for the current app process. A reload/cold launch starts with no tabs and does not restore `OPEN_TABS`, `ACTIVE_SESSION`, or saved tab lists.

## White-Box Positive

- The default relay URL resolver returns exactly `https://relay.codewhisper.cc:18443/relay/`.
- Logged-out Home receives saved Host storage and renders direct/Tailscale rows without requiring `TraversalRelayClientSettings.accessToken`.
- Logged-out Home receives current runtime Sessions and renders resume rows; resume emits an existing session-switch intent and navigates to Terminal.
- Logged-out Home always exposes the existing add/new connection intent.
- Home login calls the relay account owner with the fixed URL plus the entered account/password.
- Successful login emits the returned `TraversalRelayClientSettings` to the App bridge-settings owner.
- Successful login can add synchronized Relay/device route candidates while preserving the saved direct/Tailscale host rows.
- Relay account persistence retains token/account/directory truth but never retains the plaintext login password.
- Runtime open/close/switch still updates the in-memory open-tab projection during the current process.

## White-Box Negative

- No editable relay host/base-URL field exists on the home page.
- Home does not import or invoke `connections-server-groups`, Session-group selection, Session open, Session close, or tab-list save/load owners.
- Home must not require a Relay access token before opening the existing session picker, saved connection entry, active Session resume, or settings.
- Relay login failure must not hide or disable saved direct/Tailscale rows.
- Relay logout clears relay account/bridge relay settings without touching saved Hosts, active runtime Sessions, or open-tab truth.
- Relay account directory projection must not replace saved-host identity or become the owner of Tailscale/local direct connection truth.
- Cold bootstrap ignores and removes legacy `OPEN_TABS`, `ACTIVE_SESSION`, and `SAVED_TAB_LISTS` storage.
- Runtime tab changes do not write those storage keys.

## Module Black-Box

- Render the signed-out home with saved Tailscale/direct Hosts and assert those rows plus Add Connection are visible before Relay login.
- Render the signed-out home with active runtime Sessions and assert resume rows are visible and emit `onResumeSession(sessionId)`.
- Render the signed-out home, submit credentials, and assert fixed-domain login and explicit busy/error states without removing saved/active rows.
- Render the signed-in home and assert account identity plus online/offline daemon device rows, with no Session group controls.
- Exercise logout and assert the account owner and App relay-settings owner are both cleared while saved/active rows remain rendered.
- Mount open-tab runtime with stale legacy storage and prove startup remains empty and legacy keys are removed.

## Project Black-Box

- Build/install APK on an online Android device.
- Cold start: home shows saved direct/Tailscale connections and the fixed Relay service; Relay login is optional.
- Logged out: tap Add Connection and prove the existing session picker/connection flow opens.
- Logged out with an active current-process Session: tap Resume and prove Terminal becomes reachable without a Relay token.
- Login with a real relay account after DNS is configured; verify account device stream and daemon rows appear.
- Login/logout with saved Tailscale connections present; prove the saved rows remain visible and usable.
- Open multiple Sessions through the terminal drawer, terminate/relaunch the app, and prove no tabs are restored.

## Known External Gate

- `relay.codewhisper.cc` must resolve to the deployed relay ingress before real login can pass. Until DNS and TLS ingress are live, local tests may prove request construction only, not production authentication.
- The public Relay endpoint is an assurance path, not the direct-connection prerequisite. Production Relay failure is not allowed to block direct/Tailscale saved-host usage.
