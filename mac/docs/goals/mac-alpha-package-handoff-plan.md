# Mac Alpha Package Handoff Plan

## Objective

Close the remaining Mac P0 alpha handoff blocker so the current packaged app can be used for Jason internal alpha testing with a clear install, verification, rollback, and evidence trail.

This is the execution document for the remaining closeout `/goal`. The `/goal` prompt should reference this file instead of duplicating the implementation details.

## Acceptance Criteria

- The unsigned local Mac package is rebuilt from the current committed source and verified as the alpha handoff artifact.
- The handoff clearly distinguishes local internal alpha from signed/notarized public distribution.
- A fresh packaged app launch is verified against the required P0 smoke stack.
- Existing P0 evidence is reconciled with the current source and docs, including T-A1/T-A2/T-A3/server rail/T-A4/T-A5.
- User-data handling is explicit: what is preserved, what is safe to clear, and what is not migrated automatically.
- `mac/task.md`, `mac/docs/alpha-readiness.md`, `mac/docs/function-map.md`, `mac/docs/mainline-call-map.json`, and `mac/docs/testing/mac-desktop-workspace-test-design.md` reflect the final P0 state.
- Evidence artifacts remain ignored and unstaged.
- Final commit contains code/docs/tests for the closeout and package handoff, not `mac/evidence/**`.

## Scope

### In Scope

- Mac P0 alpha package handoff only.
- Package build verification using the existing unsigned local `electron-builder --mac dir` path.
- Fresh launch/open/quit lifecycle verification for the packaged `.app`.
- Required P0 packaged smoke reruns or evidence reconciliation.
- Release note / handoff note for Jason internal alpha use.
- Resource cleanup and tmux/CDP/process lifecycle audit.
- Final docs, maps, task board, memory, and commit.

### Out Of Scope

- Public release.
- Apple code signing, notarization, auto-update feed, DMG distribution, or installer publishing.
- New P1 features such as settings, screenshot UI, file transfer UI, schedule re-entry, or connection properties.
- Broad UI redesign.
- Clearing or migrating Jason's real user data without explicit approval.
- Killing or modifying user tmux sessions.
- Staging or committing generated evidence.

## Truth Sources

- `.agents/skills/zterm-mac-dev/SKILL.md`
- `mac/MEMORY.md`
- `mac/CACHE.md`
- `mac/note.md`
- `mac/task.md`
- `mac/docs/alpha-readiness.md`
- `mac/docs/function-map.md`
- `mac/docs/mainline-call-map.json`
- `mac/docs/testing/mac-desktop-workspace-test-design.md`
- `mac/docs/goals/mac-alpha-p0-closeout-plan.md`
- `mac/scripts/alpha-p0-packaged-smoke.mjs`
- `mac/scripts/terminal-buffer-blackbox-gate.mjs`
- `mac/package.json`

## Design Principles

- Packaged app behavior is the alpha truth; unit tests, build success, and dev server behavior do not replace packaged smoke.
- No fallback or downgraded success path. Any launch, package, runtime, transport, or buffer failure must surface explicitly and be fixed at the owner.
- Keep UI and core ownership unchanged during handoff. Package handoff should not introduce new runtime or renderer truth.
- Reuse existing dedicated smoke sessions and ports where the gate defines fixed resources; do not create timestamp session sprawl.
- Only operate on dedicated marked sessions or marker-verified fixed gate sessions.
- Evidence stays local and ignored; docs reference evidence paths but do not stage artifacts.
- The final handoff must say exactly what is alpha-ready, what remains P1/P2, and what Jason should not treat as solved.

## Technical Plan

### 1. Repo And Memory Reconciliation

- Read `mac/MEMORY.md`, `mac/CACHE.md`, `mac/note.md`, `mac/task.md`, alpha readiness, function map, mainline call map, and test design.
- Run `git status --short` and inspect unstaged changes.
- Confirm the T-A5 closeout slice is fully documented, verified, and committed before package handoff is declared complete.
- Confirm `mac/evidence/**` is ignored and not staged.

### 2. P0 Evidence Reconciliation

Verify the current alpha readiness table has evidence paths for:

- QuickConnect discovery/open.
- Header restore, tab restore, reconnect/disconnect controls.
- Remote server rail refresh/open.
- Local tmux packaged runtime smoke.
- Split pane runtime isolation.
- File browser local preview.
- Window lifecycle restore.
- Terminal buffer black-box gate with session truth vs packaged DOM rows.
- Disconnect/reconnect transport-owner close and target-scoped recovery.
- Package build and fresh packaged launch lifecycle.

If any P0 claim lacks a current packaged-app evidence path, rerun the relevant smoke before declaring handoff complete.

### 3. Package Artifact Verification

Use the existing unsigned local package path:

```bash
rtk pnpm --dir mac run package
```

Expected artifact class:

- `mac/out/mac/ZTerm.app`
- unsigned local internal alpha artifact
- not notarized
- not a public release package

Verify:

- fresh launch from packaged `.app`
- renderer loads production bundle
- core terminal path opens
- app quits without orphan ZTerm/Electron helper processes
- no broad process kill was used

### 4. Handoff Note

Create or update a Mac alpha handoff note with:

- artifact path
- build command
- verification commands
- evidence directory paths
- known limitations
- user-data boundary
- install/open steps for Jason internal alpha
- rollback/removal instruction limited to the local app artifact, not user data, unless Jason explicitly authorizes data clearing

Preferred path:

- `mac/docs/alpha-handoff.md`

### 5. Docs And Maps

Update after proof only:

- `mac/task.md`: close P0 alpha package handoff only after package and smoke evidence pass.
- `mac/docs/alpha-readiness.md`: change verdict only if all P0 blockers are closed; keep P1/P2 limitations explicit.
- `mac/docs/function-map.md`: ensure package/smoke gates and runtime owners are queryable.
- `mac/docs/mainline-call-map.json`: keep package handoff edges honest; no invented symbols.
- `mac/docs/testing/mac-desktop-workspace-test-design.md`: include package handoff gate and black-box smoke requirements.
- `mac/note.md`: record workbench findings and evidence paths.
- `mac/MEMORY.md`: append only durable verified alpha handoff facts.
- `.agents/skills/zterm-mac-dev/SKILL.md`: update only if a reusable packaging/lifecycle rule is learned.

## Verification Matrix

### Pre-Edit / Reconciliation

```bash
rtk git status --short
rtk git log --oneline -- mac packages/shared .agents/skills/zterm-mac-dev
rtk mempalace search "Mac alpha package handoff packaged smoke evidence unsigned local package" --wing zterm --results 8
```

### Directed Gates

```bash
rtk pnpm --dir mac exec vitest run src/lib/mac-architecture-truth.test.ts src/lib/bridge-transport.test.ts src/lib/local-tmux-transport.test.ts src/app/runtime/MacRuntimeRegistry.test.ts --reporter dot
rtk node --check mac/scripts/alpha-p0-packaged-smoke.mjs
rtk node --check mac/scripts/terminal-buffer-blackbox-gate.mjs
```

### Full Static / Build / Package Gates

```bash
rtk pnpm --dir mac test -- --reporter dot
rtk pnpm --dir mac run type-check
rtk pnpm --dir mac run build
rtk pnpm --dir mac run package
rtk git diff --check
```

### Required Packaged Black-Box Gates

Run or reconcile current evidence for:

```bash
rtk pnpm --dir mac run smoke:alpha-p0 -- --case=quick-connect-discovery --evidence=mac/evidence/<date>-mac-alpha-package-handoff/quick-connect-discovery
rtk pnpm --dir mac run smoke:alpha-p0 -- --case=header-restore --evidence=mac/evidence/<date>-mac-alpha-package-handoff/header-restore
rtk pnpm --dir mac run smoke:alpha-p0 -- --case=server-rail-remote-open --evidence=mac/evidence/<date>-mac-alpha-package-handoff/server-rail-remote-open
rtk pnpm --dir mac run smoke:alpha-p0 -- --case=disconnect-reconnect --evidence=mac/evidence/<date>-mac-alpha-package-handoff/disconnect-reconnect
rtk pnpm --dir mac run blackbox:terminal-buffer -- --case=all --evidence=mac/evidence/<date>-mac-alpha-package-handoff/buffer-gate
```

If source changes after a smoke pass, rerun the affected packaged smoke.

### Lifecycle Gate

- Confirm no broad process kill was used.
- Confirm no unexpected `zterm_mac_*` session sprawl.
- Confirm only dedicated marked sessions or marker-verified fixed gate sessions were written/reset.
- Confirm `process-after-close*` evidence is empty or explicitly explained.
- Confirm generated evidence is ignored/untracked and not staged.

Suggested audit:

```bash
rtk tmux list-sessions -F '#S\t#{@zterm_mac_smoke_owner}\t#{@zterm_mac_smoke_case}\t#{@zterm_mac_gate_owner}' | rtk rg '^zterm_mac_' || true
rtk git status --short
```

## Implementation Steps

1. Finish and commit any already-verified P0 closeout slice before starting handoff.
2. Reconcile Mac task/readiness/function map/mainline map/test design against committed code and current evidence.
3. Add or update `mac/docs/alpha-handoff.md`.
4. Run directed tests and script syntax checks.
5. Run full Mac test/type-check/build/package gates.
6. Run or reconcile required packaged black-box smoke gates.
7. Run lifecycle/resource cleanup audit.
8. Update `mac/task.md`, `mac/docs/alpha-readiness.md`, docs/maps/test design, `mac/note.md`, and `mac/MEMORY.md` only with verified facts.
9. Stage precise source/docs/test files and exclude `mac/evidence/**`.
10. Commit the package handoff closeout.
11. Final report: changed files, verification commands, evidence paths, remaining P1/P2 risks, and exact alpha status.

## Risks And Controls

- Risk: declaring alpha-ready from stale evidence.
  - Control: map every P0 claim to a current packaged smoke path or rerun the smoke.
- Risk: unsigned local package is mistaken for public release.
  - Control: handoff note explicitly labels it internal alpha only, unsigned and not notarized.
- Risk: packaging changes mask runtime regressions.
  - Control: run full static/build/package plus required packaged black-box gates.
- Risk: evidence leaks secrets.
  - Control: scripts must redact tokens before writing evidence; do not stage evidence.
- Risk: session/process sprawl.
  - Control: lifecycle audit and fixed/dedicated session policy.
- Risk: user data loss.
  - Control: no automatic user-data clearing or migration unless Jason explicitly authorizes it.

## Definition Of Done

- Remaining P0 blocker `alpha package handoff` is closed in `mac/task.md`.
- Alpha readiness verdict is updated only if all P0 gates are verified.
- `mac/docs/alpha-handoff.md` exists and is accurate.
- Full Mac static/unit/build/package gates pass.
- Required packaged black-box smoke evidence exists or is explicitly reconciled to unchanged source.
- Lifecycle audit passes with no unexpected process/session leftovers.
- Evidence remains ignored and unstaged.
- Final closeout commit is created.
- Final report states whether the Mac client is ready for Jason internal alpha, and names the exact remaining P1/P2 gaps.
