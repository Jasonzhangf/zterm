# Relay Settings, Home Server Rows, And Ephemeral Tabs Test Design

## Scope

- `relay.directory_ui` owns the fixed relay service auth/config projection in Settings and optional relay directory device projection into Home server rows.
- `connections.history_projection` owns saved direct/Tailscale connection history and bridge server preset projection; Home may project it but must not make Relay its owner.
- `terminal.open_tabs` owns in-process open Session state only. Open tabs and active-tab focus are not durable configuration.
- The terminal drawer remains the live Session projection. The home page must not project or manage Session groups.

## Lifecycle

1. Cold launch opens the home page with current-process active Sessions and deduped connectable server rows from saved direct/Tailscale Hosts and bridge presets.
2. Relay logged-out state is not a navigation gate: saved connections, bridge presets, active in-process Sessions, and Settings remain visible.
3. The user opens Settings to add/edit server presets or provide Relay account/password; the client sends login to `https://relay.codewhisper.cc:18443/relay/`.
4. A successful Settings login stores token/account/directory truth, updates bridge relay settings, starts the existing account device stream, and adds synchronized route/device candidates to Home projection.
5. Relay account directory can augment connection candidates, including Tailscale/local/direct endpoints, but it must not delete, replace, or hide direct saved-host truth.
6. The home page projects active runtime Sessions and server rows only as entry points. Server row tap emits session-open owner intent and enters Terminal directly; Session discovery and advanced Session actions remain in the terminal drawer/picker.
7. Open tabs exist only for the current app process. A reload/cold launch starts with no tabs and does not restore `OPEN_TABS`, `ACTIVE_SESSION`, or saved tab lists.

## White-Box Positive

- The default relay URL resolver returns exactly `https://relay.codewhisper.cc:18443/relay/`.
- Logged-out Home receives saved Host storage and renders direct/Tailscale rows without requiring `TraversalRelayClientSettings.accessToken`.
- Logged-out Home receives bridge server presets and renders one deduped server row per endpoint/daemon, not one row per saved session.
- Logged-out Home receives current runtime Sessions and renders resume rows; resume emits an existing session-switch intent and navigates to Terminal.
- Home server row with saved `sessionName` directly materializes/opens that session through `useSessionOpenActions`.
- Home server row without saved `sessionName` first creates a generated `zterm-<timestamp>` tmux session, then materializes/opens it through `useSessionOpenActions`.
- Settings login calls the relay account owner with the fixed URL plus the entered account/password.
- Successful Settings login emits the returned `TraversalRelayClientSettings` to the App bridge-settings owner.
- Settings server form upserts bridge presets; Home projects the newly configured server.
- Successful login can add synchronized Relay/device route candidates while preserving the saved direct/Tailscale host rows.
- Relay account persistence retains token/account/directory truth but never retains the plaintext login password.
- Runtime open/close/switch still updates the in-memory open-tab projection during the current process.

## White-Box Negative

- No editable relay host/base-URL field exists on the home page.
- No editable relay host/base-URL field exists in Settings; the service is fixed to `relay.codewhisper.cc`.
- Home does not import or invoke `connections-server-groups`, Session-group selection, Session close, or tab-list save/load owners.
- Home must not require a Relay access token before opening a saved/preset server row, active Session resume, or settings.
- Home server row must not stop at `TmuxSessionPickerSheet` for the normal enter path.
- Relay login failure must not hide or disable saved direct/Tailscale rows.
- Relay logout clears relay account/bridge relay settings without touching saved Hosts, active runtime Sessions, or open-tab truth.
- Relay account directory projection must not replace saved-host identity or become the owner of Tailscale/local direct connection truth.
- Cold bootstrap ignores and removes legacy `OPEN_TABS`, `ACTIVE_SESSION`, and `SAVED_TAB_LISTS` storage.
- Runtime tab changes do not write those storage keys.

## Module Black-Box

- Render the signed-out home with saved Tailscale/direct Hosts and bridge presets and assert server rows plus Settings/config entry are visible before Relay login.
- Render the signed-out home with active runtime Sessions and assert resume rows are visible and emit `onResumeSession(sessionId)`.
- Render Settings, submit credentials, and assert fixed-domain login and explicit busy/error states without removing saved/active Home rows.
- Render Settings, add a direct server, save, and assert bridge settings receive the preset.
- Render the signed-in Home and assert relay directory daemon devices can be projected as server rows, with no Session group controls.
- Exercise logout and assert the account owner and App relay-settings owner are both cleared while saved/active rows remain rendered.
- Mount open-tab runtime with stale legacy storage and prove startup remains empty and legacy keys are removed.

## Project Black-Box

- Build/install APK on an online Android device.
- Cold start: home shows saved direct/Tailscale/bridge-preset server rows; Relay login is not on Home and remains optional in Settings.
- Logged out: tap a configured server row and prove Terminal becomes reachable without a Relay token.
- Logged out: open Settings, add a server preset, save, and prove Home shows the new server row.
- Logged out with an active current-process Session: tap Resume and prove Terminal becomes reachable without a Relay token.
- Login with a real relay account in Settings after DNS is configured; verify account device stream and daemon rows appear on Home as server candidates.
- Login/logout with saved Tailscale connections present; prove the saved rows remain visible and usable.
- Open multiple Sessions through the terminal drawer, terminate/relaunch the app, and prove no tabs are restored.

## Known External Gate

- `relay.codewhisper.cc` must resolve to the deployed relay ingress before real login can pass. Until DNS and TLS ingress are live, local tests may prove request construction only, not production authentication.
- The public Relay endpoint is an assurance path, not the direct-connection prerequisite. Production Relay failure is not allowed to block direct/Tailscale saved-host usage.
