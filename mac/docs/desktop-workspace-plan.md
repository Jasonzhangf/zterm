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

- `mac/src/App.tsx` still renders `ShellWorkspace`.
- `ShellWorkspace` has a useful split tree and per-resource runtime registry.
- `MacAppShell/MacPaneWorkbench` is a newer but non-production path.
- `MacAppShell/MacPaneWorkbench` currently passes one runtime into all panes, so it cannot be the multi-live-pane target without refactoring.
- Electron main creates one business `BrowserWindow`; there is no multi-window owner.
- Server management is in `QuickConnectSheet`, not in a persistent server directory.

Design decision:

- Keep the split-tree and per-resource runtime lessons from `ShellWorkspace`.
- Do not keep `ShellWorkspace` as an all-in-one UI/runtime owner.
- Build a new production mainline with explicit owners.
- Remove or migrate obsolete entrypoint code after the new mainline is verified.

## Owner Map

| Feature | Owner | Allowed paths | Forbidden paths | Required gates |
| --- | --- | --- | --- | --- |
| Mac app entrypoint | `MacDesktopApp` | `mac/src/App.tsx`, `mac/src/app/*` | `mac/src/pages/ShellWorkspace.tsx` as new feature sink | `pnpm --filter @zterm/mac type-check`, `pnpm --filter @zterm/mac build` |
| Window lifecycle | `MacWindowManager` | `mac/electron/main.ts`, preload window IPC bridge | terminal runtime files | type-check, build, package when changed |
| Workspace state | `MacWorkspaceStore` | `mac/src/app/workspace/*` | transport, buffer, renderer | unit tests, type-check |
| Pane tree layout | `MacPaneTree` | shared pane tree helpers or `mac/src/app/workspace/*` | terminal transport/runtime | unit tests for split/resize/move |
| Runtime session registry | `MacRuntimeRegistry` | `mac/src/app/runtime/*`, thin wrappers around `mac/src/lib/terminal-runtime.ts` | pane/tab UI components | runtime registry unit tests, terminal smoke when behavior changes |
| Server directory | `MacServerDirectory` | shared server identity helpers, `mac/src/app/server-directory/*` | runtime transport | projection tests, type-check |
| Connection launcher | `MacConnectionLauncher` | `mac/src/app/launcher/*` | server directory truth | UI tests, projection tests |
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
-> MacServerDirectory.fetchSessions(serverId)
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
- Move current usable `ShellWorkspace` behavior behind explicit child owners or keep it as a temporary adapter named accordingly.
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
- Persist by `workspaceId`, not one global `shell-workspace`.

Verification:

```bash
pnpm --filter @zterm/mac test -- workspace
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

### Slice 3: Runtime registry

Goal: guarantee independent live panes without recreating transports on tab switch.

Changes:

- Add `MacRuntimeRegistry`.
- Registry owns `runtimeKey -> TerminalRuntimeController`.
- Pane UI only requests a runtime and consumes projection.
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
pnpm --filter @zterm/mac test -- runtime
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

Runtime smoke required before declaring the slice complete.

### Slice 4: Server directory

Goal: make multi-server management a first-class desktop surface.

Changes:

- Add left server rail.
- Reuse shared server identity projection when possible.
- Show server groups, live sessions, refresh status, and errors.
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
pnpm --filter @zterm/mac test -- server
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

### Slice 5: Electron multi-window

Goal: support OS-level windows without mixing window state into terminal truth.

Changes:

- Add `MacWindowManager` in Electron main.
- Add menu/shortcut for New Window.
- Pass `windowId` to renderer.
- Persist each window's workspace separately.

Verification:

```bash
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
pnpm --filter @zterm/mac package
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

After Slice 1 and Slice 3 pass:

- Rename any retained `ShellWorkspace` adapter to make transitional status explicit.
- Remove unused `MacAppShell/MacPaneWorkbench` path or migrate it into the new owners.
- Delete obsolete tests that assert the old entrypoint, after equivalent tests exist for the new mainline.

Deletion must be in a verified commit with tests proving the replacement path.
