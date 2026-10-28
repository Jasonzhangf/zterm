# Session Drawer Collab Filter Redesign

Issue: `69ac2bd`

## User requirement (2026-10-27)

The session drawer must stop asking the user to maintain master and subagent
session names by hand.

- Master classification must come from Collab. The host has commands that
  expose registered identity, role, and tmux transport location. The drawer
  must consume that projection.
- The drawer filters tmux sessions. It must not invent a second identity
  registry or infer roles from session names.
- Hide and show must be interactive in the session list. The Settings page
  must not expose manual master, subagent, or hidden-session name fields.
- The drawer itself needs a frontend redesign. The current narrow list reads
  as an unfinished utility panel; it must become a legible, dense Operate
  surface with clear hierarchy, filter controls, row actions, and restore
  flow.

## Architecture mapping

- Business flow: `daemon.session_catalog -> resource.daemon_session_catalog ->
  client.session_drawer_ui`.
- Unique owner for Collab role observation: `daemon.session_catalog`.
  It reads the host Collab projection with `collab who`, resolves tmux
  session ids to catalog names, and attaches an optional typed `collab`
  projection to catalog entries.
- Unique owner for drawer projection and interaction:
  `client.session_drawer_ui` plus `terminal.session_drawer`.
- The existing `resource.daemon_session_catalog` carries the new optional
  field. No new module or cross-module edge is introduced.
- The daemon never sends input, registers identities, changes Collab state, or
  controls tmux lifecycle. Collab observation is read-only and failure is
  isolated from the required session catalog.

## Acceptance

- A catalog entry may carry
  `collab: { role: 'master' | 'worker'; displayName: string; agentState?: string }`.
- Collab observation uses the registered tmux transport namespace and socket,
  not session display names. Unknown or ambiguous targets stay unclassified.
- Collab command failure or timeout leaves the session catalog complete and
  unclassified; it does not clear live sessions or fail the default catalog.
- Drawer modes are `all`, `only-master`, and `hide-worker`. Classification uses
  the catalog projection only.
- The Settings page no longer renders manual master, subagent, or hidden-name
  textareas.
- Hiding a row is available from the row action menu. Hidden rows can be
  restored individually from the drawer's hidden tray and restored in bulk.
- Drawer width, header, filter controls, host selector, folder groups, rows,
  empty state, hidden tray, and footer form one coherent Operate surface.
- Mobile touch targets are at least 40px where the action is primary; keyboard
  focus remains visible; long names truncate without colliding with badges.
- Required gates include the daemon catalog suite, drawer visibility suite,
  drawer component suite, TerminalPage drawer suite, Settings drawer-filter
  suite, and registry/import gates.
- Android L5 evidence requires an installed build on an online device or
  Emulator with before/after screenshots and logcat. Source tests alone do not
  close the mobile gate. OTA is claimed only after the authorized build and
  published manifest are verified.

## Non-goals

- No Collab registration, send, identity mutation, or tmux lifecycle action.
- No manual role registry and no name-based master inference.
- No changes to terminal buffer, renderer, transport, or input ownership.
- No production startup-path test hook.

## Current delivery state

- Daemon catalog reads `collab who`, resolves the registered tmux session id and
  socket through the live tmux catalog, and exposes a typed projection.
- Relay directory normalization and daemon publication preserve the optional
  projection.
- Drawer classification uses only that projection.
- r1/r2 landed the projection into drawer rows, the filter and hidden tray
  interactions, and removed the manual Settings name fields.
- r3 closed the five review P1 findings (stale role on failed resample,
  socket-qualified identity, native-identity cache with ambiguity recheck,
  deduped observations, relay republish on in-place resample, host-scoped
  empty states). Master re-ran the gates: tsc 0, the ten-file suite 266
  passed, ambient keeps only the pre-existing `ResourceBottomSheet` baseline
  failure.
- r4 (visual redesign) is running in the same worktree. It must remove the
  conflicting blanket `.zterm-neo-drawer` skeu `!important` layer, deliver a
  coherent light/dark Operate surface, and capture real 15T screenshots.
- Remaining after r4: milestone review, commit/merge/push, and Android L5/OTA
  only when the authorized build is actually made.
