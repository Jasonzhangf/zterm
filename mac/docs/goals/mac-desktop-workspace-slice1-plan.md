# Mac Desktop Workspace Slice 1 Plan

## Goal

Implement Slice 1 from `mac/docs/desktop-workspace-plan.md`: introduce one production Mac renderer entrypoint and stop the current documentation/code mismatch around `ShellWorkspace`.

## Acceptance Criteria

- `mac/src/App.tsx` renders a single production entrypoint named `MacDesktopApp` or an equivalent clearly named owner.
- The new entrypoint is responsible only for renderer bootstrapping and workspace shell composition.
- Existing useful behavior from `ShellWorkspace` is kept only behind explicitly transitional child owners or adapters.
- `MacAppShell/MacPaneWorkbench` must not remain a second production entrypoint.
- Runtime behavior is not expanded in this slice; no new multi-window or server rail implementation yet.
- Tests prove the renderer root uses the new entrypoint and does not silently regress to `ShellWorkspace`.

## Scope

In scope:

- Add the new production entrypoint shell.
- Add or update tests for app entrypoint ownership.
- Move only the minimum existing shell behavior needed to keep the app buildable.
- Keep the implementation aligned with `mac/docs/spec.md`, `mac/docs/architecture.md`, and `mac/docs/desktop-workspace-plan.md`.

Out of scope:

- Electron `BrowserWindow` multi-window implementation.
- Server directory rail.
- Runtime registry refactor.
- Profiles and arrangements.
- Visual polish beyond preserving a usable shell.
- Terminal protocol or daemon changes.

## Design Principles

- Owner first: entrypoint must not own runtime session truth.
- No fallback: if a transitional adapter is needed, name it explicitly and document its removal path.
- No duplicate production semantics: do not keep `ShellWorkspace` and `MacAppShell` as peer production roots.
- UI shell only composes layout; terminal rendering and transport stay in existing runtime/renderer owners.
- Preserve currently working build behavior while making the ownership boundary visible.

## Technical Plan

Primary files:

- `mac/src/App.tsx`
- `mac/src/app/MacDesktopApp.tsx` or equivalent
- `mac/src/app/*` tests
- `mac/docs/desktop-workspace-plan.md`
- `mac/task.md`
- `mac/note.md`

Possible transitional approach:

- Create `MacDesktopApp`.
- Move current `ShellWorkspace` usage behind a clearly named temporary adapter such as `MacWorkspaceTransitionalShell`.
- Add TODO/removal notes only in docs/task, not as vague code comments.
- Ensure there is one renderer root in `App.tsx`.

## Risks And Mitigations

- Risk: Accidentally reintroducing the single-runtime multi-pane path from `MacAppShell/MacPaneWorkbench`.
  Mitigation: do not route production through `MacPaneWorkbench` unless runtime ownership is split first.

- Risk: Big-bang refactor touching runtime and UI at once.
  Mitigation: only change entrypoint ownership in this slice.

- Risk: Tests assert implementation details but not owner boundary.
  Mitigation: add a direct App/root test plus targeted owner tests.

## Test Plan

Required static gates:

```bash
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac build
```

Required targeted tests:

```bash
pnpm --filter @zterm/mac test -- MacDesktopApp
```

If targeted test name differs, run the exact new/updated test file directly.

No packaged smoke is required unless Electron main/preload/package behavior changes.

## Implementation Steps

1. Read `mac/docs/desktop-workspace-plan.md`, `mac/docs/spec.md`, `mac/docs/architecture.md`, `mac/task.md`, and this plan.
2. Add the `MacDesktopApp` production entrypoint.
3. Update `App.tsx` to render only the new entrypoint.
4. Keep any old workspace behavior behind a transitional adapter with a clear owner name.
5. Add/adjust tests to lock the new entrypoint.
6. Run targeted tests, type-check, and build.
7. Update `mac/task.md` and `mac/note.md` with verified status and remaining risks.
8. Do not implement Slice 2+ in the same change.

## Definition Of Done

- One production renderer entrypoint exists.
- The old entrypoint mismatch is removed or explicitly isolated as transitional internals.
- Required tests/build pass.
- The final report lists what changed, exact verification commands, and what remains out of scope.
