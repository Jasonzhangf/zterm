# Mac Desktop Workspace Plan

## Goal

Build the Mac client as a desktop terminal workspace that can manage multiple servers, multiple windows, tabs, and split panes while keeping the Android terminal contract unchanged.

The target desktop hierarchy is:

```text
App
-> Window
-> Workspace
-> PaneTree
-> Pane
-> Tab
-> RuntimeSession
```

This mirrors the useful iTerm2 model: OS windows contain tabs and split panes, and each visible pane can own an independent live terminal session.

## Non-Goals

- Do not create a second desktop-only terminal buffer truth.
- Do not let daemon/server learn client window, pane, active tab, viewport, or foreground state.
- Do not keep both `ShellWorkspace` and `MacAppShell` as competing production entrypoints.
- Do not start with visual polish before owner boundaries and CI gates are locked.
- Do not implement broadcast input until per-pane runtime isolation is verified.

## Current Truth And Conflict

Current code evidence:

- `mac/src/App.tsx` renders `MacDesktopApp`.
- `MacDesktopApp` renders `MacAppShell`; this is the current production renderer path.
- `MacAppShell` now creates `MacRuntimeRegistry`, ensures runtimes for live tabs, sets the active runtime key, and releases closed runtime keys.
- `MacPaneWorkbench` now consumes registry projections by `runtimeKey`; pane UI no longer calls `connectRemote` / `connectLocalTmux`.
- `MacWorkspaceStore` / `MacPaneTree` pure model now exists under `mac/src/app/workspace/*`; production renderer bootstraps and saves workspace identity by renderer `windowId` through `MacAppShell`.
- The old all-in-one `ShellWorkspace` source has been physically removed after replacement coverage passed. Schedule, screenshot, file-transfer, QuickConnect, Details, and Terminal primitives remain only as standalone future owner inputs.
- Electron main now creates `MacWindowManager`, which owns BrowserWindow creation, New Window menu/IPC actions, persisted open window records, activate focus/restore, and renderer `windowId` query injection. Packaged multi-window restore smoke has passed.
- Server management now has a persistent `MacServerDirectory` rail in the production shell for saved server/session projection, read-only remote daemon live refresh, refresh status/errors, and explicit open actions. `ConnectionLauncher` / `QuickConnectSheet` remain add/edit/manual connect surfaces. Packaged read-only refresh smoke passed against the local Mac Studio daemon.
- Local file browser / preview now has three owners: shared `FileBrowserCore`, `MacFileBrowserPanel`, and the Mac Electron local filesystem adapter. Unit/component tests and packaged local browse/preview smoke pass.
- Runtime registry is statically, unit-test, and packaged-smoke verified. Packaged tmux A/B smoke proves two panes connected, input/echo isolation, resize, switch, close, and B input after A close.

Design decision:

- Keep the verified split-tree and per-resource runtime lessons in the new owner modules.
- Do not restore `ShellWorkspace` as an all-in-one UI/runtime owner.
- Build a new production mainline with explicit owners.
- Remove or migrate obsolete entrypoint code after the new mainline is verified.
- Use `mac/docs/function-map.md` and `mac/docs/mainline-call-map.json` as the owner/mainline truth before implementation slices.
- Slice 1 entrypoint correction, Slice 2 workspace store, Slice 3 runtime registry, Slice 4 server directory including read-only remote live refresh, Slice 5 `MacWindowManager`, the local file browser branch, and Slice 7 legacy cleanup are implemented and verified through their required gates.

## Owner Map

| Feature | Owner | Allowed paths | Forbidden paths | Required gates |
| --- | --- | --- | --- | --- |
| Mac app entrypoint | `MacDesktopApp` | `mac/src/App.tsx`, `mac/src/app/*` | any restored `mac/src/pages/ShellWorkspace.tsx` feature sink | `pnpm --filter @zterm/mac type-check`, `pnpm --filter @zterm/mac build` |
| Window lifecycle | `MacWindowManager` | `mac/electron/main.ts`, preload window IPC bridge | terminal runtime files | type-check, build, package when changed |
| Workspace state | `MacWorkspaceStore` | `mac/src/app/workspace/*` | transport, buffer, renderer | unit tests, type-check |
| Pane tree layout | `MacPaneTree` | shared pane tree helpers or `mac/src/app/workspace/*` | terminal transport/runtime | unit tests for split/resize/move |
| Runtime session registry | `MacRuntimeRegistry` | `mac/src/app/runtime/*`, thin wrappers around `mac/src/lib/terminal-runtime.ts` | pane/tab UI components | runtime registry unit tests, terminal smoke when behavior changes |
| Server directory | `MacServerDirectory` | shared server identity helpers, `mac/src/app/server-directory/*`, thin `MacAppShell` refresh orchestration | runtime transport, workspace open/close/prune during refresh | projection tests, refresh success/error tests, type-check, packaged read-only refresh smoke when route is available |
| Connection launcher | `MacConnectionLauncher` | `mac/src/app/launcher/*` | server directory truth | UI tests, projection tests |
| File browser core | `FileBrowserCore` | `packages/shared/src/files/*` | React, Electron IPC, terminal runtime | shared core tests, architecture import gate |
| File browser UI | `MacFileBrowserPanel` | `mac/src/app/file-browser/*` | terminal runtime, Electron fs policy | component tests, packaged fs smoke |
| Local filesystem adapter | `createMacLocalFileSystemService`, `registerMacFileSystemIpcHandlers` | `mac/electron/file-system.ts`, preload bridge | preview policy, UI state | IPC tests, package, packaged fs smoke |
| Terminal rendering | shared terminal renderer | `packages/shared/src/terminal/*`, thin Mac consumer | app shell layout | renderer tests, terminal smoke |

## Mainline Call Map

### Window open

```text
Electron menu / app activate
-> MacWindowManager.createWindow(windowId)
-> BrowserWindow loads renderer with windowId
-> MacDesktopApp bootstraps workspace for windowId
-> MacWorkspaceStore.load(windowId)
-> MacWorkspaceShell renders server directory + pane tree
```

### Open session

```text
User selects server/session in MacServerDirectory or MacConnectionLauncher
-> MacWorkspaceActions.openTab({ windowId, paneId, serverId, sessionName })
-> MacWorkspaceStore persists tab identity
-> MacRuntimeRegistry.ensureRuntime(runtimeKey)
-> TerminalRuntime.connectRemote/connectLocalTmux
-> MacTerminalPane consumes runtime render projection
```

### Split pane

```text
User invokes split right/down
-> MacWorkspaceActions.splitPane({ windowId, paneId, direction })
-> MacPaneTree updates layout only
-> New pane starts empty or receives moved tab
-> Runtime registry unchanged until a tab is opened or activated
```

### Switch tab or pane

```text
User activates pane/tab
-> MacWorkspaceStore updates active pane/tab
-> MacRuntimeRegistry sets visible runtime active, hidden runtime idle
-> Runtime identity and transport are not recreated
```

### Server refresh

```text
User refreshes server or server directory auto-refresh tick fires
-> MacServerDirectoryRail explicit refresh button
-> MacAppShell calls fetchMacServerDirectoryLiveSessionSnapshot(server)
-> Projection updates live sessions for that server
-> Workspace open tabs are not created/closed by projection
-> Unavailable sessions are displayed as unavailable transport facts
```

## Data Contracts

### `MacWindowRecord`

```ts
interface MacWindowRecord {
  windowId: string;
  title: string;
  bounds?: { x: number; y: number; width: number; height: number };
  workspaceId: string;
  lastFocusedAt: number;
}
```

### `MacWorkspaceRecord`

```ts
interface MacWorkspaceRecord {
  workspaceId: string;
  paneTree: MacPaneTreeNode;
  panes: MacPaneRecord[];
  activePaneId: string;
  updatedAt: number;
}
```

### `MacPaneRecord`

```ts
interface MacPaneRecord {
  paneId: string;
  tabs: MacTabRecord[];
  activeTabId: string;
}
```

### `MacTabRecord`

```ts
interface MacTabRecord {
  tabId: string;
  kind: 'empty' | 'remote' | 'local-tmux';
  title: string;
  runtimeKey?: string;
  serverId?: string;
  sessionName?: string;
  localSessionName?: string;
}
```

### `MacRuntimeKey`

```ts
type MacRuntimeKey =
  | `remote:${serverId}:${sessionName}`
  | `local-tmux:${sessionName}`;
```

Runtime key is a client-side identity only. It must not become daemon truth.

## Server Directory UI

Mac should use a persistent left rail instead of making `QuickConnectSheet` the primary server manager.

Structure:

```text
Left rail
  Servers
    mac-studio
      live sessions
      new session
      refresh
    macbookair
      live sessions
      new session
      refresh
    windows-pc
      live sessions
      new session
      refresh

Main
  Window tab strip
  Pane tree
  Terminal panes
```

Rules:

- Server display name, color, endpoint alias, and daemon identity must come from one server identity projection.
- Live sessions come from daemon/server enumeration and are projection only.
- Opening a live session is an explicit user action.
- Refreshing server sessions cannot create, close, or prune workspace tabs.
- `New session` belongs to a selected server and asks for name/path before creating.

## Visual Direction

The Mac UI should be terminal-first:

- Thin top chrome.
- Persistent but narrow server rail.
- Pane tabs compact and close to terminal content.
- Pane controls visible on hover or command palette, not permanently occupying every pane.
- Server identity shown by stable color and label, not host:port unless the user asks for endpoint details.
- Profiles and arrangements are command surfaces, not full-time panels.

## Implementation Slices

### Slice 0: Design and gate alignment

Goal: make docs, tasks, and verification agree before code changes.

Changes:

- Add this plan as the design truth.
- Update `mac/docs/spec.md`.
- Update `mac/docs/architecture.md`.
- Add `mac/docs/function-map.md`.
- Add `mac/docs/mainline-call-map.json`.
- Add `mac/docs/testing/mac-desktop-workspace-test-design.md`.
- Add a low-false-positive architecture truth gate for current entrypoint truth, map parseability, and required owner IDs.
- Update `mac/docs/dev-workflow.md` only if gates change.
- Update `mac/task.md`.

Verification:

```bash
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

No packaged smoke required because no runtime code changes.

### Slice 1: Entrypoint owner

Goal: introduce one production entrypoint and stop the document/code mismatch.

Changes:

- Create `MacDesktopApp` as the only renderer entrypoint.
- Keep replacement behavior behind explicit child owners. Do not recreate `ShellWorkspace` as a temporary adapter.
- Add a test that `App` renders the new entrypoint.

Verification:

```bash
pnpm --filter @zterm/mac test -- MacDesktopApp
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

### Slice 2: Workspace store and pane tree

Goal: make window/workspace/pane/tab state independent from terminal runtime.

Changes:

- Add `MacWorkspaceStore` pure model.
- Add split right/down, close pane, move tab, activate tab tests.
- Persist by `workspaceId`, not one legacy global shell workspace key.

Verification:

```bash
pnpm --filter @zterm/mac test -- workspace
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

### Slice 3: Runtime registry

Goal: guarantee independent live panes without recreating transports on tab switch.

Changes:

- Add `MacRuntimeRegistry`. Implemented in `mac/src/app/runtime/MacRuntimeRegistry.ts`.
- Registry owns `runtimeKey -> TerminalRuntimeController`.
- `MacAppShell` ensures runtimes for live tabs and sets active runtime key.
- `MacPaneWorkbench` consumes projection and routes input/viewport/resize through registry by runtime key.
- Hidden runtime goes idle, not dispose.

Positive tests:

- Two panes with different runtime keys create two runtimes.
- Switching tab sets old runtime idle and new runtime active.
- Closing the last tab for a runtime disposes only that runtime.

Negative tests:

- Switching pane does not call `connectRemote` again for the same runtime key.
- Hidden tab is not disposed.
- Runtime state is not stored in pane records.

Verification:

```bash
pnpm --dir mac exec vitest run src/app/runtime/MacRuntimeRegistry.test.ts src/app/MacPaneWorkbench.test.tsx src/app/MacAppShell.layout.test.tsx --reporter dot
pnpm --dir mac test -- --reporter dot
pnpm --dir mac run type-check
pnpm --dir mac run build
```

Runtime smoke required before declaring the slice complete.

### Slice 4: Server directory

Goal: make multi-server management a first-class desktop surface.

Changes:

- Add left server rail. Implemented in `mac/src/app/server-directory/MacServerDirectoryRail.tsx`.
- Reuse shared server identity projection when possible.
- Show server groups, saved sessions, daemon live session snapshots, refresh status/errors, and open-session state.
- Move `QuickConnectSheet` to add/edit server flow.

Positive tests:

- Multiple servers render as separate groups.
- Server color and label stay stable across rail and pane tab.
- Selecting a session opens a tab in active pane.

Negative tests:

- Refreshing live sessions does not create workspace tabs.
- Unavailable session does not close an already open tab.

Verification:

```bash
pnpm --dir mac exec vitest run src/app/server-directory/MacServerDirectory.test.ts src/app/MacAppShell.layout.test.tsx --reporter dot
pnpm --dir mac run type-check
pnpm --dir mac run build
```

Packaged read-only daemon refresh smoke evidence:

```text
mac/evidence/2026-07-04-server-refresh-smoke/
```

### Slice 5: Electron multi-window

Goal: support OS-level windows without mixing window state into terminal truth.

Changes:

- Add `MacWindowManager` in Electron main. Implemented in `mac/electron/window-manager.ts`.
- Add menu/shortcut for New Window. Implemented through `createMacWindowMenuTemplate` and the preload `windowManager.createWindow()` IPC bridge.
- Pass `windowId` to renderer. Implemented through dev URL/file query injection and `resolveMacRendererWindowId`.
- Persist each window's workspace separately. Implemented through `MacAppShell` + `MacWorkspaceStore` localStorage key `zterm:mac:workspace:v1:<windowId>`.
- Preserve open window records on app quit and restore them on next launch. Implemented through `createFileMacWindowRecordStore` and `MacWindowManager.restoreWindows()`.

Verification:

```bash
pnpm --dir mac exec vitest run src/electron/window-manager.test.ts src/app/window/window-id.test.ts src/app/MacDesktopApp.test.tsx src/app/MacAppShell.layout.test.tsx --reporter dot
pnpm --dir mac test -- --reporter dot
pnpm --dir mac run type-check
pnpm --dir mac run build
pnpm --dir mac run package
```

Packaged smoke required:

- Open app.
- Create second window.
- Open different sessions in different windows.
- Quit and reopen.
- Confirm workspaces restore without transport confusion.

### Slice 6: Profiles and arrangements

Goal: add iTerm2-like profiles and arrangements without mixing them with runtime state.

Profiles own:

- title template
- default server
- default session name/path command
- terminal theme/font/density
- width mode

Arrangements own:

- window count
- workspace pane tree
- tabs by runtime key
- active pane/tab

Profiles do not own live buffer, connection state, or daemon state.

Verification:

```bash
pnpm --filter @zterm/mac test -- profile arrangement
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

## CI Gate Matrix

| Change type | Required CI | Runtime smoke | Package smoke |
| --- | --- | --- | --- |
| Docs only | type-check, build if touched references must compile | no | no |
| Pure workspace model | targeted tests, type-check, build | no | no |
| Renderer layout | targeted tests, type-check, build | dev smoke if interactive path changed | no unless packaged behavior changed |
| Runtime registry | targeted tests, type-check, build | yes | no unless Electron/preload changed |
| Electron main/preload/window | type-check, build, package | yes | yes |
| Local tmux | tests, type-check, build, package | yes with dedicated tmux session | yes |
| Remote bridge/session | tests, type-check, build | yes against real daemon | package if release/smoke requested |

## Removal Plan

Code cannot keep duplicate production meanings.

After Slice 1, Slice 3, and replacement package/live gates pass:

- Do not retain a `ShellWorkspace` adapter.
- Remove unused duplicate production paths or migrate them into the new owners.
- Delete obsolete tests that assert the old entrypoint after equivalent tests exist for the new mainline.
- Slice 7 result: `mac/src/pages/ShellWorkspace.tsx`, `mac/src/pages/ShellWorkspace.split-tree.test.tsx`, and `mac/src/lib/shell-workspace.ts` are physically removed and guarded by `mac/src/lib/mac-architecture-truth.test.ts`.

Deletion must be in a verified commit with tests proving the replacement path.
