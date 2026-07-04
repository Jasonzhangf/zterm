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

## Current Slice Status

| Slice | Scope | Test status |
| --- | --- | --- |
| Slice 0 docs/maps/gate | baseline docs, function map, call map, test design, architecture truth gate skeleton | implemented in this slice |
| Slice 1 entrypoint | `App -> MacDesktopApp` | implemented; covered by `src/App.test.tsx` and `src/app/MacDesktopApp.test.tsx` |
| Slice 2 workspace store | `MacWorkspaceStore` / `MacPaneTree` pure model | implemented; production renderer bootstraps by `windowId` and packaged window restore smoke passed |
| Slice 3 runtime registry | `MacRuntimeRegistry` | implemented in code and white-box tests; packaged A/B tmux input/resize/switch/close isolation smoke passed |
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
- File browser open intent does not call terminal runtime connect/disconnect. Implemented in `mac/src/app/file-browser/MacFileBrowserPanel.test.tsx` and `mac/src/app/MacAppShell.layout.test.tsx`.
- Server rail projection does not call workspace open/close actions; `MacAppShell` opens a tab only from explicit rail click. Implemented in `MacAppShell.layout.test.tsx`.
- Server rail refresh click calls only the live refresh helper, projects returned sessions, and does not call `addHost`, `setBridgeSettings`, `ensureRuntime`, or workspace open. Implemented in `MacAppShell.layout.test.tsx`.
- Server rail refresh failure displays status/error while keeping saved/open sessions visible. Implemented in `MacAppShell.layout.test.tsx`.
- `MacDesktopApp` passes URL `windowId` to `MacAppShell`. Implemented in `MacDesktopApp.test.tsx`.
- `MacAppShell` saves workspace identity by `windowId` and does not write legacy shell workspace storage. Implemented in `MacAppShell.layout.test.tsx`.

## Module Black-Box Plan

Renderer/app black-box:

- App boots to one desktop workspace shell.
- Empty workspace shows terminal-first open affordance.
- Split creates independent visual pane containers.
- Opening two local tmux sessions creates two tabs/panes with distinct status surfaces.
- Switching tabs does not clear previous render projection.
- Server rail shows saved servers and live sessions.
- Opening a session from server rail creates a tab only on explicit click.
- Refreshing a server rail group lists real daemon tmux sessions but does not create a tab until explicit open.
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
8. Capture `ps/top` resource snapshot.
9. Quit app and verify no orphan ZTerm/Electron helper process.

Evidence path:

```text
mac/evidence/<date>-mac-desktop-workspace-refactor/
```

## Verification Matrix

| Change type | White-box | Module black-box | Project/package |
| --- | --- | --- | --- |
| Docs/maps/gate | architecture truth gate | not required | type-check/build only |
| Workspace pure model | workspace unit tests | renderer split shell test | type-check/build |
| Runtime registry | registry positive/negative tests | local tmux A/B isolation | type-check/build plus runtime smoke |
| Server directory | projection tests, refresh success/error negative tests | explicit open-only app test; read-only remote daemon refresh smoke when route is available | type-check/build |
| File browser shared core | core unit tests, import gate | fixture directory browse/preview | package smoke if Electron fs changes |
| Electron window manager | window manager tests | multi-window renderer smoke | package + packaged smoke |
| Legacy cleanup | architecture scan | replacement path black-box tests | full Mac tests/type-check/build; package if runtime/window changed |

## Known Gaps

- Runtime registry now has packaged A/B tmux evidence for input/echo isolation, resize, switch, close, and B after-close input under `mac/evidence/2026-07-04-runtime-live-isolation-smoke/`.
- Legacy `ShellWorkspace` all-in-one source is removed. Schedule modal, remote screenshot, file transfer, QuickConnect, Details, and Terminal primitives are retained only as standalone future owner inputs, not as fallback workspace semantics.
- `MacWorkspaceStore` pure model exists and `MacDesktopApp` / `MacAppShell` now bootstrap renderer state from `windowId`; packaged multi-window restore smoke passed.
- `MacServerDirectory` projects saved servers/sessions, explicit refresh status/errors, and live daemon snapshots; read-only real-daemon refresh smoke must still be run for each routed endpoint before claiming remote live coverage.
- Local file browser owner is implemented in shared core + Electron adapter + Mac panel tests, with packaged local browse/preview smoke evidence under `mac/evidence/2026-07-04-file-browser-smoke/`.
