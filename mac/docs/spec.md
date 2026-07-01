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

- `mac/src/App.tsx` still renders `ShellWorkspace`.
- `ShellWorkspace` contains useful split-tree and per-resource runtime registry behavior, but it is an all-in-one transitional owner.
- `MacAppShell/MacPaneWorkbench` is not the production entrypoint and currently uses one runtime across panes.
- Electron creates one business `BrowserWindow`.
- Multi-server management is still modal-first via `QuickConnectSheet`.

This mismatch is intentional debt to remove in the implementation slices. Do not claim the Mac desktop workspace is complete until the slices in `desktop-workspace-plan.md` are verified.

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
