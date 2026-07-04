# zterm Mac Spec

## Product Goal

Build the Mac client as a terminal-first desktop workspace for multiple servers, multiple OS windows, tabs, and split panes.

The canonical design document is:

- `mac/docs/desktop-workspace-plan.md`

Mac must keep the same terminal contract model as Android:

```text
Server(session truth)
-> Client Buffer Worker
-> Renderer Container
-> UI Shell
```

Desktop features are platform shell features. They must not create a second terminal buffer, renderer, transport, or daemon truth.

## Target Hierarchy

```text
App
-> Window
-> Workspace
-> PaneTree
-> Pane
-> Tab
-> RuntimeSession
```

Rules:

- A window owns one workspace.
- A workspace owns pane tree layout and pane/tab identity.
- A pane owns its tab list and active tab.
- A tab may reference a runtime key.
- Runtime state is owned by the runtime registry, not by UI records.
- Server directory projections cannot create or close workspace tabs.

## Current Baseline

Current code does not yet satisfy this spec:

- `mac/src/App.tsx` renders `MacDesktopApp`, which renders `MacAppShell`.
- `MacAppShell/MacPaneWorkbench` is the current production renderer path. It now uses `MacRuntimeRegistry` for `runtimeKey -> TerminalRuntimeController`; `MacPaneWorkbench` consumes assigned runtime projection and does not call runtime connect methods.
- The old all-in-one `ShellWorkspace` source has been physically removed after replacement coverage passed. Schedule, screenshot, file-transfer, QuickConnect, Details, and Terminal primitives remain only as standalone components/protocol helpers for future owner slices, not as a workspace fallback.
- Electron window lifecycle now goes through `MacWindowManager`, which creates BrowserWindows with stable renderer `windowId`, supports explicit New Window through menu/IPC, persists open window records on app quit, restores the same `windowId`s on app restart, and restores/focuses an existing managed window on macOS activate. Packaged multi-window restore smoke has evidence under `mac/evidence/2026-07-04-window-manager-smoke/`.
- Multi-server management now has a persistent `MacServerDirectory` rail for saved server/session projection and read-only remote daemon live refresh in the production shell. `ConnectionLauncher` / `QuickConnectSheet` remain the add/edit/manual connect surfaces. Packaged refresh smoke has evidence under `mac/evidence/2026-07-04-server-refresh-smoke/`.
- Local file browser / preview now has `FileBrowserCore` in shared, `MacFileBrowserPanel` in the production shell, and a Mac Electron filesystem adapter; packaged local browse/preview smoke has evidence under `mac/evidence/2026-07-04-file-browser-smoke/`.
- Independent live-pane runtime behavior has packaged evidence for two dedicated tmux panes connected, input/echo isolation, resize, switch, close, and B input after A close under `mac/evidence/2026-07-04-runtime-live-isolation-smoke/`.

Do not claim the Mac desktop workspace is complete beyond the verified slices in `desktop-workspace-plan.md`; future schedule, screenshot, file transfer, profile, and settings owners still require their own maps and gates.

## In Scope

- One production renderer entrypoint.
- Explicit window/workspace/pane/tab/runtime owners.
- Persistent server rail for multi-server management.
- Independent live runtime sessions per visible pane/tab resource key.
- OS-level new window support.
- Compact terminal-first desktop UI.
- Profiles and arrangements after owner boundaries are verified.

## Out Of Scope Until Owner Gates Pass

- Broadcast input.
- Full iTerm2 feature parity.
- Desktop-only terminal protocol changes.
- Visual polish without owner/test coverage.
- Any fallback path that masks runtime or transport failures.

## Acceptance Gates

Minimum gates for docs-only design changes:

```bash
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

Runtime-affecting slices must also satisfy `mac/docs/dev-workflow.md` and the gate matrix in `mac/docs/desktop-workspace-plan.md`.
