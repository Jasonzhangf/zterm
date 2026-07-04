# zterm Mac Architecture

## Truth Sources

1. `mac/docs/spec.md` — Mac product target and current baseline.
2. `mac/docs/desktop-workspace-plan.md` — desktop workspace owner map, mainline call map, implementation slices, CI gates.
3. `mac/docs/dev-workflow.md` — Mac verification workflow.
4. `android/docs/architecture.md` — cross-platform terminal ownership truth.
5. `android/docs/decisions/0001-cross-platform-layout-profile.md` — layout profile and shared pane truth.
6. `android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md` — terminal head / sparse buffer / render container truth.
7. `.agents/skills/terminal-buffer-truth/SKILL.md` — buffer/render/scroll hard gate.
8. `mac/task.md` — current task board.
9. `mac/CACHE.md` — short-term context.
10. `mac/MEMORY.md` — long-term lessons.
11. `mac/evidence/` — verification evidence.

## Core Terminal Model

Mac and Android share one terminal contract:

```text
Server(session truth)
  -> Client Buffer Worker
  -> Renderer Container
  -> UI Shell
```

### Server(session truth)

- tmux / daemon is the only session truth.
- Server only owns tmux mirror, head/range response, physical transport, and daemon runtime.
- Server must not own Mac window, pane, active tab, foreground/background, viewport, or width-mode state.

### Client Buffer Worker

- Mac buffer is a sparse absolute-index mirror.
- Hidden/inactive runtime can reduce pull activity, but switching UI state must not recreate transport identity.
- Buffer worker does not know window chrome, server rail, launcher, profile menu, or pane layout.

### Renderer Container

- Renderer consumes canonical render projection.
- Renderer owns visible range state such as follow/reading/render bottom through shared renderer truth.
- Renderer must not initiate business decisions such as opening tabs, refreshing servers, or mutating workspace layout.

### UI Shell

- UI shell owns window/workspace/pane/tab layout and user interaction.
- UI shell asks runtime registry for a runtime by key.
- UI shell does not merge buffers, repair payloads, or reinterpret daemon protocol.

## Desktop Workspace Model

The desktop ownership hierarchy is:

```text
App
-> Window
-> Workspace
-> PaneTree
-> Pane
-> Tab
-> RuntimeSession
```

Module responsibilities:

| Module | Owns | Does not own |
| --- | --- | --- |
| Electron Platform Shell | BrowserWindow lifecycle, menu, preload IPC, windowId | terminal buffer, runtime session, pane truth |
| MacDesktopApp | renderer root, bootstrapping window workspace | transport protocol |
| MacWorkspaceStore | window/workspace/pane/tab records | live connection state |
| MacPaneTree | split layout, resize, pane activation | terminal runtime |
| MacRuntimeRegistry | runtimeKey to TerminalRuntimeController lifecycle | pane tree layout |
| MacServerDirectory | server identity, live session projection | open tabs, runtime state |
| MacConnectionLauncher | add/edit/connect server flow | server projection truth |
| MacFileBrowserPanel | local file browser UI state and preview projection | terminal runtime, Electron fs policy |
| FileBrowserCore | path/sort/preview policy | React UI, Electron IPC, terminal runtime |
| Mac local filesystem adapter | local fs list/read/dialog IPC | preview policy, UI state, terminal runtime |
| Shared Terminal Renderer | terminal projection display/input surface | workspace mutation |

## Current Transitional State

The repository currently contains conflicting paths:

- Production renderer entrypoint: `App -> MacDesktopApp -> MacAppShell`.
- `MacAppShell/MacPaneWorkbench` is current production. Runtime creation/connect/activity is now owned by `MacRuntimeRegistry`; pane UI consumes assigned runtime projection and routes input/viewport/resize by `runtimeKey`.
- The old all-in-one `ShellWorkspace` path has been physically removed. It must not return as fallback workspace semantics; retained schedule, screenshot, file-transfer, QuickConnect, Details, and Terminal primitives need explicit future owners before reuse.
- Implemented owner modules: `MacWorkspaceStore`, `MacRuntimeRegistry`, `MacServerDirectory`, `MacWindowManager`, `FileBrowserCore`, `MacFileBrowserPanel`, and the Mac local filesystem adapter.
- Verified packaged behavior: `MacWindowManager` multi-window restore smoke has evidence under `mac/evidence/2026-07-04-window-manager-smoke/`; local file browser browse/preview smoke has evidence under `mac/evidence/2026-07-04-file-browser-smoke/`; runtime A/B input/resize/switch/close isolation smoke has evidence under `mac/evidence/2026-07-04-runtime-live-isolation-smoke/`; server rail read-only daemon refresh smoke has evidence under `mac/evidence/2026-07-04-server-refresh-smoke/`.
- Incomplete target behavior: profiles/arrangements, schedule UI re-entry, screenshot UI re-entry, file-transfer UI re-entry, settings, and terminal renderer closeout still need dedicated owner slices.

Design decision:

- Build the new owner modules from `desktop-workspace-plan.md`.
- Reuse only verified useful behavior from transitional code.
- Do not keep duplicate production entrypoints after replacement tests pass.
- Record every owner, mainline edge, and pending binding in `mac/docs/function-map.md` and `mac/docs/mainline-call-map.json` before deeper refactors.

## Multi-Server Boundary

Server directory is a projection layer:

- It may show saved servers, daemon identities, live sessions, refresh state, and errors.
- It may trigger explicit user actions such as open session, new session, edit server, refresh.
- It must not create/close/prune workspace tabs from refresh results.
- It must use a single server identity/color projection shared with Android where possible.

## Verification Boundary

Each implementation slice must update tests before or with code:

- Pure model: unit tests + type-check + build.
- Renderer UI: component tests + type-check + build.
- Runtime registry: positive and negative lifecycle tests + runtime smoke.
- Electron window/preload: type-check + build + package + packaged smoke.
- Terminal behavior: follow the terminal closed-loop gates from Android and `zterm-mac-dev`.
