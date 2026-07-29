# Mac Desktop Workspace Test Design

## Purpose

This is the test design record for the Mac desktop workspace refactor in `docs/goals/mac-desktop-workspace-refactor-plan.md`.

Use it with:

- `mac/docs/function-map.md`
- `mac/docs/mainline-call-map.json`
- `mac/docs/desktop-workspace-plan.md`
- `.agents/skills/zterm-mac-dev/SKILL.md`

## Lifecycle Under Test

```text
MAC-00-AppEntry
-> MAC-01-DesktopBootstrap
-> MAC-02-WindowRecord
-> MAC-03-WorkspaceLoad
-> MAC-04-WorkspaceShell
-> MAC-05-ServerDirectory
-> MAC-06-OpenTabIntent
-> MAC-07-PaneTreeUpdate
-> MAC-08-RuntimeEnsure
-> MAC-09-RuntimeActivity
-> MAC-10-TerminalProjection
-> MAC-11-Renderer
```

Server refresh branch:

```text
MAC-05-ServerDirectory
-> MAC-17-ServerLiveRefresh
-> MAC-05-ServerDirectory
```

QuickConnect branch:

```text
MAC-04-WorkspaceShell
-> MAC-19-QuickConnectDiscovery
-> MAC-20-QuickConnectOpen
-> MAC-03-WorkspaceLoad
```

File browser branch:

```text
MAC-04-WorkspaceShell
-> MAC-12-FileBrowserOpen
-> MAC-13-FileProviderRead
-> MAC-14-FilePreview
```

Window restore branch:

```text
MAC-02-WindowRecord
-> MAC-15-WindowRestore
```

Legacy cleanup:

```text
MAC-16-LegacyRemoval
-> replacement owner nodes
```

Local tmux provider branch:

```text
MAC-08-RuntimeEnsure
-> MAC-18-LocalTmuxProvider
-> MAC-09-RuntimeActivity
-> MAC-10-TerminalProjection
-> MAC-11-Renderer
```

## Current Slice Status

| Slice | Scope | Test status |
| --- | --- | --- |
| Slice 0 docs/maps/gate | baseline docs, function map, call map, test design, architecture truth gate skeleton | implemented in this slice |
| Slice 1 entrypoint | `App -> MacDesktopApp` | implemented; covered by `src/App.test.tsx` and `src/app/MacDesktopApp.test.tsx` |
| Slice 2 workspace store | `MacWorkspaceStore` / `MacPaneTree` pure model | implemented; production renderer bootstraps by `windowId` and packaged window restore smoke passed |
| Slice 3 runtime registry | `MacRuntimeRegistry` | implemented in code and white-box tests; packaged A/B tmux input/resize/switch/close isolation smoke passed |
| Alpha P0 T-A2 cold restore | `MacWorkspaceStore` + `MacRuntimeRegistry` active-only eager connect | packaged `smoke:alpha-p0 -- --case=header-restore` passed under `mac/evidence/2026-07-05-mac-alpha-p0-closeout/header-restore-final2/` |
| Alpha P0 T-A3 terminal header | `MacTerminalPane` + `MacRuntimeRegistry` controls | packaged `smoke:alpha-p0 -- --case=header-restore` passed; white-box locks error state is not wrapped as connected |
| Alpha P0 T-A1 QuickConnect discovery | `ConnectionLauncher` + `MacAppShell.handleSaveDraft` | packaged `smoke:alpha-p0 -- --case=quick-connect-discovery` passed under `mac/evidence/2026-07-05-mac-alpha-p0-closeout/quick-connect-discovery-final3/`; discovery creates no runtime and explicit Save & connect opens remote runtime |
| Alpha P0 T-A5 disconnect/reconnect | `MacRuntimeRegistry` + transport owners | packaged `smoke:alpha-p0 -- --case=disconnect-reconnect` passed under `mac/evidence/2026-07-05-mac-alpha-p0-closeout/disconnect-reconnect-final2/`; transport-owner close projects explicit error, official Reconnect restores active runtime, hidden runtime remains disconnected |
| Slice 4 server directory | persistent rail projection | saved/open projection and explicit open-only UI implemented; remote live refresh wiring now targets projection-only status/live session state |
| Slice 5 file browser | shared core + Mac UI + Electron fs adapter | implemented in unit/component tests; packaged fs browse/preview smoke passed |
| Slice 6 Electron window manager | multi-window + windowId | implemented in `MacWindowManager`; packaged multi-window create + quit/reopen restore smoke passed |
| Slice 7 legacy cleanup | obsolete ShellWorkspace source removal | implemented; old all-in-one page/lib/test physically deleted and hard-gated by architecture truth |

## White-Box Plan

### Architecture Truth Gate

File: `mac/src/lib/mac-architecture-truth.test.ts`.

Slice 0 hard checks:

- `App.tsx` does not import or render `ShellWorkspace`.
- `mac/docs/function-map.md` exists and contains all required `feature_id` rows.
- `mac/docs/mainline-call-map.json` parses as JSON.
- `mac_desktop_mainline` contains required node IDs.
- Required adjacent edges exist with `edge_id`, `owner_feature`, `caller`, `callee`, semantic input/output, status, and verification gates.
- Current docs do not contain stale baseline claims that `App.tsx` still renders `ShellWorkspace`.

Slice 3 hard checks now active:

- `MacRuntimeRegistry` is anchored as the current production runtime owner.
- `MacAppShell` no longer calls `createTerminalRuntime` or `useTerminalRuntimeState`.
- `MacPaneWorkbench` / pane UI no longer calls `connectRemote` or `connectLocalTmux`.

Slice file browser hard checks now active:

- File browser core imports no React, Electron, terminal runtime, or platform fs code.
- Electron fs adapter contains no preview policy.
- `MacFileBrowserPanel` opens through explicit app UI and does not call runtime connect/disconnect.

Local tmux provider hard checks now active:

- `LocalTmuxManager` remains the Electron-side local tmux capture/input/head/sync owner.
- Canonical tmux capture for head/sync keeps SGR with `capture-pane -e -p`.
- Canonical tmux capture must include visible pane bottom; `capture-pane -E -1` is forbidden for local tmux head/sync payloads because it can omit the live visible tail and make app rows stale relative to `tmux capture-pane` truth.

Slice 7 hard checks now active:

- `mac/src/pages/ShellWorkspace.tsx`, `mac/src/pages/ShellWorkspace.split-tree.test.tsx`, and `mac/src/lib/shell-workspace.ts` do not exist.
- No production source under `mac/src` references `ShellWorkspace`.
- `MAC-16-LegacyRemoval` and `MAC-EDGE-0017` are anchored in `mac/docs/mainline-call-map.json`.

Slice 5 hard checks now active:

- `MacWindowManager` is anchored as the BrowserWindow/windowId owner.
- `MacDesktopApp` passes renderer `windowId` to `MacAppShell`.
- `MacAppShell` persists workspace identity under `zterm:mac:workspace:v1:<windowId>`, not legacy shell storage.
- Workspace records do not contain runtime, transport, buffer, or render projection fields.

### Pure Model Unit Tests

`mac.workspace_store`:

- load/save by `windowId`.
- create initial workspace with one pane and one empty tab.
- split right/down updates pane tree only.
- resize ratios remain normalized and deterministic.
- move tab across panes preserves tab identity.
- empty pane click activates that pane and opens the session chooser without creating runtime.
- change-session context action opens a scoped pending replacement without removing the selected tab until a new session is confirmed; chooser cancel leaves the original tab/runtime identity intact.
- move-to-numbered-pane context action moves the tab to the chosen pane and leaves runtime truth owned by `MacRuntimeRegistry`.
- close tab/pane never stores runtime state.
- invalid persisted workspace fails explicitly.
- renderer bootstrap loads/saves by `windowId`.

`mac.runtime_registry`:

- two distinct runtime keys create two controllers. Implemented in `mac/src/app/runtime/MacRuntimeRegistry.test.ts`.
- the same runtime key reuses the same controller. Implemented.
- remote target connect runs once for same key/signature. Implemented.
- local tmux connect runs once for same key/session. Implemented.
- pane/tab switch sets previous runtime idle and next runtime active. Implemented.
- same active tab switch does not reconnect. Implemented.
- hidden tab is not disposed. Implemented.
- closing last tab for a runtime disposes only that runtime. Implemented as `releaseRuntime`.
- stale event from runtime A cannot update runtime B projection. Implemented.
- input, viewport, and resize route only to the assigned runtime key. Implemented.
- reconnect uses the stored target only for the requested runtime key and leaves siblings untouched. Implemented.
- reconnect without a prepared target returns false instead of silently succeeding. Implemented.

`mac.local_tmux_provider`:

- local tmux head/sync requests are routed through the preload IPC bridge to `LocalTmuxManager`.
- `readSessionCapture(...)` uses one canonical history-plus-visible capture for both head and sync.
- head/sync capture preserves ANSI SGR with `-e` and does not end at `-E -1`.
- alternate screen capture uses bounded visible current screen truth with `capture-pane -e -p -S -<paneRows>`, so full-history scrollback cannot become the live TUI refresh payload.
- packaged sequence gate proves app-rendered tail contains the same controlled numbered output as tmux truth.
- packaged TUI gate proves continuously refreshing bottom content advances in app rendered rows within bounded lag.
- unexpected local tmux `closed` events project explicit runtime error, while manual disconnect remains idle. Implemented in `mac/src/lib/local-tmux-transport.test.ts`.
- smoke-only `forceCloseForSmoke` is only enabled under `--zterm-alpha-smoke` and is used to prove transport-owner close/error before reconnect in packaged smoke.

`mac.window_lifecycle`:

- Electron window manager creates a BrowserWindow with stable `windowId`.
- dev server and packaged file loads include `windowId` in renderer query.
- New Window menu and preload IPC call the window owner.
- activate/focus reuses an existing managed window instead of creating duplicate windows.
- closed windows are removed from manager records.
- app quit preserves open window records and app restart restores them by the same `windowId`.

`mac.server_directory`:

- saved servers group by shared server identity. Implemented in `mac/src/app/server-directory/MacServerDirectory.test.ts`.
- live sessions project under the owning server. Implemented as optional snapshot input.
- refresh changes projection only. Implemented: pure projection has no workspace/runtime imports.
- unavailable session does not close an already open workspace tab. Implemented for saved/open session projection.
- duplicate endpoint alias resolves to one server identity. Implemented.
- explicit open intent does not mutate projection. Implemented.
- remote live refresh helper returns a snapshot for one server from `fetchTmuxSessions` without mutating workspace/runtime state.
- missing host/token and daemon errors are explicit refresh errors, not empty successful session lists.

`mac.quick_connect`:

- `ConnectionLauncher` accepts a test-injectable session fetcher and does not directly create workspace tabs.
- remote discovery requires explicit user action and a host/token.
- discovery success stores unique session names and preselects the latest saved matching session when possible.
- discovery failure shows an explicit error and keeps the typed target editable.
- Save & connect opens only the selected/typed target through `MacAppShell.handleSaveDraft`.
- no terminal runtime is created until the explicit open command reaches workspace state.

`mac.file_browser_core`:

- normalizes local paths without consulting Electron. Implemented in `packages/shared/src/files/file-browser-core.test.ts`.
- sorts directory-first by name and time. Implemented.
- detects text preview candidates. Implemented.
- disables binary preview. Implemented.
- requires explicit confirmation for large text preview. Implemented.
- provider error surfaces as error, not empty directory. Implemented.

`mac.platform_fs`:

- lists local filesystem facts and returns raw provider errors. Implemented in `mac/src/electron/file-system.test.ts`.
- reads, writes, and creates local files/directories as IO-only operations. Implemented.
- rejects path traversal file names for writes. Implemented.
- registers IPC handlers for list/read/save/mkdir/download-dir/select-directory. Implemented.

### Component White-Box Tests

- `MacTerminalPane` consumes the projection for its assigned `runtimeKey`.
- Input from pane A calls runtime A only.
- Pane B render is unchanged when runtime A emits.
- Terminal header shows runtime status, session label, terminal size, reconnect, disconnect, and error text without wrapping errors as connected.
- Terminal reconnect/disconnect controls call `MacRuntimeRegistry` only, not direct transport primitives.
- File browser open intent does not call terminal runtime connect/disconnect. Implemented in `mac/src/app/file-browser/MacFileBrowserPanel.test.tsx` and `mac/src/app/MacAppShell.layout.test.tsx`.
- Server rail projection does not call workspace open/close actions; `MacAppShell` opens a tab only from explicit rail click. Implemented in `MacAppShell.layout.test.tsx`.
- Server rail refresh click calls only the live refresh helper, projects returned sessions, and does not call `addHost`, `setBridgeSettings`, `ensureRuntime`, or workspace open. Implemented in `MacAppShell.layout.test.tsx`.
- Server rail remote open is a two-step proof: Refresh projects a live daemon session with zero runtime calls, then an explicit session click creates the remote runtime and connected terminal. White-box implemented in `MacAppShell.layout.test.tsx`; packaged proof uses `pnpm --dir mac run smoke:alpha-p0 -- --case=server-rail-remote-open`.
- Server rail refresh failure displays status/error while keeping saved/open sessions visible. Implemented in `MacAppShell.layout.test.tsx`.
- `MacDesktopApp` passes URL `windowId` to `MacAppShell`. Implemented in `MacDesktopApp.test.tsx`.
- `MacAppShell` saves workspace identity by `windowId` and does not write legacy shell workspace storage. Implemented in `MacAppShell.layout.test.tsx`.

## Module Black-Box Plan

Renderer/app black-box:

- App boots to one desktop workspace shell.
- Empty workspace shows terminal-first open affordance.
- Split creates independent visual pane containers.
- Blank split panes are clickable chooser targets and display explicit pane numbering.
- Existing pane tabs expose context actions to change session or move the tab to an explicit `Pn`.
- Opening two local tmux sessions creates two tabs/panes with distinct status surfaces.
- Switching tabs does not clear previous render projection.
- Server rail shows saved servers and live sessions.
- Opening a session from server rail creates a tab only on explicit click.
- Refreshing a server rail group lists real daemon tmux sessions but does not create a tab until explicit open. Packaged smoke case: `server-rail-remote-open`.
- File browser opens from command/toolbar and lists a fixture directory. Implemented in component tests; packaged smoke passed.
- Text file preview displays content. Implemented in component tests; packaged smoke passed.
- Binary file preview is disabled. Implemented in component tests; packaged smoke passed.
- Large text file requires confirm. Implemented in component tests; packaged smoke passed.

Runtime black-box:

- Dedicated local tmux session `zterm_mac_goal_a` connects and echoes input.
- Dedicated local tmux session `zterm_mac_goal_b` connects and echoes input.
- Input A does not appear in B.
- Resize A does not reset B.
- Switching A idle / B active keeps A buffer.
- Closing A disposes A runtime only.
- `header-restore` packaged smoke seeds a window-scoped workspace with one active local tmux tab and one hidden local tmux tab, closes/reopens the packaged app, and proves the same `windowId`, active tab, hidden tab, header projection, active-only `ensureRuntime(connect:true)`, hidden `ensureRuntime(connect:false)`, active-only actual runtime connect, active-only disconnect, and reconnect-to-connected.
- `disconnect-reconnect` packaged smoke seeds active and hidden local tmux tabs, records the active local clientId through smoke diagnostics, forces a transport-owner close under `--zterm-alpha-smoke`, proves explicit `error`, clicks the official Reconnect control, proves active runtime returns to `connected`, hidden runtime connect count stays `0`, active runtime connect count is `2`, and `windowId` remains stable.

QuickConnect black-box:

- Open connection command displays remote host/port/token fields.
- Discover calls the daemon `list-sessions` path and shows returned sessions.
- Most recent saved matching session is preselected when present; otherwise first returned session is selected.
- Save & connect opens the selected session and only then creates the runtime.
- Packaged `quick-connect-discovery-final3` proves the real UI input path (`Input.insertText`), real daemon config route, dedicated marked tmux session `zterm_mac_alpha_quick`, redacted storage snapshots, and explicit lifecycle cleanup.

Terminal buffer black-box:

- Gate command: `pnpm --dir mac run blackbox:terminal-buffer -- --case=all`.
- Session source truth is `tmux capture-pane`; input oracle is `tmux pipe-pane`; app output target is packaged app DOM rendered rows (`data-terminal-row-text`).
- `sequence` case proves app input reaches the dedicated session and the rendered tail contains the same controlled numbered output as tmux truth.
- `tui` case proves a continuously refreshing bottom TUI screen advances in the app render output and stays within bounded lag of tmux truth.
- `large-reading` case proves large output can enter scrollback reading mode, new output does not steal the reading position, scroll-to-bottom returns to follow, append tail matches tmux truth, and renderer viewport demand reaches runtime diagnostics.
- This gate is required before closing `T-A4`; connected status, screenshots, bottom geometry, or local renderer unit tests do not replace it.

Remote daemon black-box, only when a real daemon route is available:

- Remote session open uses bridge two-stage handshake.
- Server/session refresh returns real daemon facts.
- Server/session refresh is read-only observation against existing daemon sessions; it must not write tmux input or create/kill sessions.
- Server/session refresh leaves the workspace pane/tab count unchanged until explicit user click.
- File-list request returns a real directory response.
- File preview/download works against a fixture file.

If daemon or route is unavailable, report remote live coverage missing. Do not use local-only proof as remote closure.

## Project Black-Box / Packaged Smoke

Package smoke is required for Electron main/preload/window/local filesystem changes.

Minimum steps:

1. Run `pnpm --filter @zterm/mac package`.
2. Quit old app by app-level quit or explicit PID only.
3. Open the newly packaged app.
4. Capture screenshot evidence.
5. Open local file browser fixture and preview a text file.
6. Open two dedicated local tmux sessions in separate panes.
7. Verify input, resize, switch, and close behavior.
8. Run terminal buffer black-box gate against packaged app:
   `pnpm --dir mac run blackbox:terminal-buffer -- --case=all --evidence=mac/evidence/<date>-mac-alpha-p0-closeout/buffer-gate`
9. Capture `ps/top` resource snapshot.
10. Quit app and verify no orphan ZTerm/Electron helper process.

Evidence path:

```text
mac/evidence/<date>-mac-desktop-workspace-refactor/
```

## Verification Matrix

| Change type | White-box | Module black-box | Project/package |
| --- | --- | --- | --- |
| Docs/maps/gate | architecture truth gate | not required | type-check/build only |
| Workspace pure model | workspace unit tests | renderer split shell test | type-check/build |
| Runtime registry | registry positive/negative tests | local tmux A/B isolation; alpha `header-restore` active-only smoke | type-check/build plus runtime smoke plus `blackbox:terminal-buffer` when terminal buffer/render behavior is claimed |
| Terminal header/status | pane header tests, runtime registry reconnect/disconnect tests | header status and control transitions | package plus `pnpm --dir mac run smoke:alpha-p0 -- --case=header-restore` |
| Disconnect/reconnect | registry target-only reconnect tests; bridge/local unexpected close -> error tests; manual disconnect -> idle tests | active transport-owner close -> error -> official reconnect -> connected; hidden runtime untouched | package plus `pnpm --dir mac run smoke:alpha-p0 -- --case=disconnect-reconnect` |
| Local tmux provider | architecture truth gate forbids visible-tail-omitting capture; local transport tests; smoke-only forced close boundary | session truth vs app rows through dedicated tmux sessions; reconnect smoke uses local transport-owner close | package plus `pnpm --dir mac run blackbox:terminal-buffer -- --case=all`; `pnpm --dir mac run smoke:alpha-p0 -- --case=disconnect-reconnect` |
| Server directory | projection tests, refresh success/error negative tests | explicit open-only app test; read-only remote daemon refresh smoke; packaged `server-rail-remote-open` proves refresh no-runtime then click connected | type-check/build/package |
| File browser shared core | core unit tests, import gate | fixture directory browse/preview | package smoke if Electron fs changes |
| Electron window manager | window manager tests | multi-window renderer smoke | package + packaged smoke |
| Legacy cleanup | architecture scan | replacement path black-box tests | full Mac tests/type-check/build; package if runtime/window changed |
| Terminal buffer/render | runtime + pane owner tests | session truth vs rendered rows, sequence, TUI refresh, and large-output reading/return-follow | package plus `pnpm --dir mac run blackbox:terminal-buffer -- --case=all` |

## Known Gaps

- Runtime registry now has packaged A/B tmux evidence for input/echo isolation, resize, switch, close, and B after-close input under `mac/evidence/2026-07-04-runtime-live-isolation-smoke/`.
- Terminal buffer correctness now has packaged black-box evidence under `mac/evidence/2026-07-05-mac-alpha-p0-closeout/buffer-gate-all-t-a4-final/` showing `sequence`, `tui`, and `large-reading` passing under the alpha closeout evidence directory.
- Disconnect/reconnect now has packaged evidence under `mac/evidence/2026-07-05-mac-alpha-p0-closeout/disconnect-reconnect-final2/` showing explicit transport error projection, official reconnect recovery, active runtime connect count `2`, hidden runtime connect count `0`, stable `windowId`, and clean post-close process/session lifecycle.
- Legacy `ShellWorkspace` all-in-one source is removed. Schedule modal, remote screenshot, file transfer, QuickConnect, Details, and Terminal primitives are retained only as standalone future owner inputs, not as fallback workspace semantics.
- `MacWorkspaceStore` pure model exists and `MacDesktopApp` / `MacAppShell` now bootstrap renderer state from `windowId`; packaged multi-window restore smoke passed.
- `MacServerDirectory` projects saved servers/sessions, explicit refresh status/errors, and live daemon snapshots; read-only real-daemon refresh smoke must still be run for each routed endpoint before claiming remote live coverage.
- Local file browser owner is implemented in shared core + Electron adapter + Mac panel tests, with packaged local browse/preview smoke evidence under `mac/evidence/2026-07-04-file-browser-smoke/`.
