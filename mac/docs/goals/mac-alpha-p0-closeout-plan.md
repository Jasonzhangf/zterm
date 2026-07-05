# Mac Alpha Closeout Plan

## Objective

Close the remaining Mac client P0 alpha blockers and produce a packaged-app evidence trail good enough for Jason internal alpha testing.

This plan is the execution document for the closeout `/goal`. The `/goal` prompt should reference this file instead of duplicating the implementation details.

## Acceptance Criteria

- `T-A5 断线自动重连` is verified end-to-end against the packaged Mac app.
- The disconnect/reconnect path proves explicit error state on daemon/transport close and recovery through the official reconnect control.
- Reconnect is target-scoped: reconnecting one pane/runtime must not recreate or mutate unrelated panes, tabs, sessions, or transports.
- Packaged smoke evidence exists under `mac/evidence/<date>-mac-alpha-p0-closeout/`.
- `mac/task.md`, `mac/docs/alpha-readiness.md`, `mac/docs/function-map.md`, `mac/docs/mainline-call-map.json`, and `mac/docs/testing/mac-desktop-workspace-test-design.md` reflect the verified state.
- All evidence artifacts remain ignored and unstaged.
- Final commit contains code/docs/tests for the closeout slice, not evidence blobs.

## Scope

### In Scope

- Mac packaged app closeout for remaining P0 alpha blockers.
- T-A5 reconnect implementation and packaged smoke gate.
- White-box tests for runtime/transport reconnect ownership and negative cases.
- Function map and mainline call map updates for the reconnect lifecycle.
- Alpha readiness and task board updates after proof.
- Lifecycle audit of packaged app process, CDP port, and dedicated tmux sessions.

### Out of Scope

- Public release, signing, notarization, installer distribution, or update feed.
- Broad UI redesign beyond what is required to close alpha blockers.
- Rewriting daemon/client architecture outside the reconnect owner boundary.
- Killing or modifying user tmux sessions.
- Staging or committing `mac/evidence/**`.

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
- `mac/scripts/alpha-p0-packaged-smoke.mjs`
- `mac/scripts/terminal-buffer-blackbox-gate.mjs`

## Design Principles

- No fallback or downgraded success path. Transport close/error must surface explicitly, and reconnect must recover through the single runtime owner path.
- `MacRuntimeRegistry` remains the runtime lifecycle owner.
- Transport owners expose real connection state; UI controls route through registry controls only.
- Daemon/transport truth and client workspace truth stay separated.
- Dedicated smoke sessions must be marker-verified before write/reset/cleanup.
- Existing fixed gate sessions should be reused; do not create timestamp session sprawl.
- Packaged behavior is the alpha truth; unit tests and build success do not replace packaged smoke.

## Technical Plan

### T-A5 Owner Mapping

Confirm current ownership before editing:

- `mac.runtime_registry`: reconnect target storage, runtime controls, target-scoped reconnect.
- `mac/src/lib/terminal-runtime.ts`: runtime state projection and reconnect/disconnect orchestration.
- `mac/src/lib/bridge-transport.ts`: remote daemon WebSocket close/error state.
- `mac/src/lib/local-tmux-transport.ts`: local tmux transport close/error state.
- `MacTerminalPane` / `MacPaneWorkbench`: control surface only; no direct transport calls.

If function map or mainline map cannot identify the owner/edge within 1-2 lookups, update the maps first and mark unverified edges as `binding pending` until source is confirmed.

### Packaged Smoke Case

Add a T-A5 case to `mac/scripts/alpha-p0-packaged-smoke.mjs`, likely:

```bash
pnpm --dir mac run smoke:alpha-p0 -- --case=disconnect-reconnect --evidence=mac/evidence/<date>-mac-alpha-p0-closeout/disconnect-reconnect
```

The smoke must prove:

- Packaged app opens a dedicated marked target.
- The target reaches connected state.
- A real daemon/transport close or equivalent transport-owner close produces explicit error state.
- The terminal header/control exposes reconnect from that error state.
- Reconnect returns to connected state through the official UI/control path.
- Workspace identity, pane ID, tab ID, and runtime target remain stable.
- Unrelated pane/runtime, if included in the fixture, is not recreated or mutated.
- After quit, no stray ZTerm/Electron helper process remains.
- Dedicated tmux/session resources are either marker-verified retained for reuse or marker-verified cleaned up.

Preferred proof route:

- Use real remote daemon/transport close if safely automatable.
- If daemon restart is not safe, use a transport close path that exercises the real transport owner and error projection. Do not fake success through a UI-only disconnect.

### White-Box Tests

Add or extend tests for:

- `MacRuntimeRegistry`: reconnect uses stored target only for the requested runtime key.
- `MacRuntimeRegistry`: no prepared target means reconnect fails explicitly or no-ops visibly, not silently successful.
- `terminal-runtime`: transport close/error projects non-connected state and does not wrap error as connected.
- `bridge-transport` and/or `local-tmux-transport`: close/error events are surfaced deterministically.
- Negative target isolation: reconnect of A must not reconnect B, recreate B, or mutate B projection.

### Docs And Maps

After proof, update:

- `mac/task.md`: mark T-A5 complete only after packaged proof passes.
- `mac/docs/alpha-readiness.md`: move T-A5 out of P0 blockers only after evidence exists; keep package handoff limitations explicit.
- `mac/docs/function-map.md`: bind reconnect owner, required tests, and packaged smoke gate.
- `mac/docs/mainline-call-map.json`: add verified adjacent reconnect/error/recovery edges with real caller/callee symbols.
- `mac/docs/testing/mac-desktop-workspace-test-design.md`: add T-A5 white-box, module black-box, and packaged black-box gate.
- `mac/note.md`: record workbench findings and evidence paths.
- `mac/MEMORY.md`: append only verified durable Mac alpha facts.
- `.agents/skills/zterm-mac-dev/SKILL.md`: update only if a reusable lifecycle rule or anti-pattern is learned.

## Verification Matrix

### Pre-Edit Recon

- `rtk git status --short`
- `rtk mempalace search "Mac T-A5 disconnect reconnect daemon transport error recovery packaged" --wing zterm --results 8`
- Read source around reconnect/error owners before editing.

### Directed White-Box

- Runtime registry reconnect tests.
- Transport close/error tests.
- Terminal runtime error/reconnect projection tests.
- Architecture truth gate if docs/maps changed.

### Full Static / Unit Gates

```bash
rtk pnpm --dir mac test -- --reporter dot
rtk pnpm --dir mac run type-check
rtk pnpm --dir mac run build
rtk pnpm --dir mac run package
rtk node --check mac/scripts/alpha-p0-packaged-smoke.mjs
rtk git diff --check
```

Run shared tests only if shared code changes:

```bash
rtk pnpm --dir packages/shared exec vitest run --reporter dot
```

### Packaged Black-Box Gates

Run the new reconnect gate:

```bash
rtk pnpm --dir mac run smoke:alpha-p0 -- --case=disconnect-reconnect --evidence=mac/evidence/<date>-mac-alpha-p0-closeout/disconnect-reconnect
```

Keep the existing buffer gate as the terminal data correctness gate when terminal buffer/render behavior is touched or claimed:

```bash
rtk pnpm --dir mac run blackbox:terminal-buffer -- --case=all --evidence=mac/evidence/<date>-mac-alpha-p0-closeout/buffer-gate
```

### Lifecycle Gate

- Verify no broad process kill was used.
- Verify no unexpected `zterm_mac_*` session sprawl.
- Verify only dedicated marker-matched sessions were written/reset.
- Verify `process-after-close*` evidence is empty or explicitly explains remaining process.
- Verify `mac/evidence/**` is untracked/ignored and not staged.

## Implementation Steps

1. Reconcile current repo state, memory, function map, mainline call map, and T-A5 source owner.
2. Add T-A5 test design/map entries if the owner edge is missing or only implicit.
3. Implement directed white-box tests for reconnect/error/target isolation.
4. Implement the packaged `disconnect-reconnect` smoke case.
5. Make minimal source changes required for the tests and packaged smoke to pass.
6. Run directed white-box gates.
7. Run full Mac test/type-check/build/package gates.
8. Run packaged reconnect smoke and lifecycle gate.
9. Update task/readiness/docs/memory only after proof.
10. Commit the T-A5 closeout slice.
11. Prepare alpha package handoff status separately, clearly distinguishing unsigned local package from public release.

## Risks And Controls

- Risk: UI disconnect path is mistaken for transport error.
  - Control: packaged smoke must induce transport-owner close/error and observe explicit error state.
- Risk: reconnect recreates unrelated runtime/session.
  - Control: white-box target isolation test and packaged workspace identity checks.
- Risk: smoke pollutes user tmux sessions.
  - Control: dedicated marker-verified session only; no writes to unmarked sessions.
- Risk: evidence leaks secrets.
  - Control: redact auth token fields before writing smoke evidence.
- Risk: process/session lifecycle sprawl.
  - Control: pre/post resource inventory and marker-verified cleanup/retention.

## Definition Of Done

- T-A5 code path is implemented through the correct owner.
- T-A5 has positive and negative white-box tests.
- T-A5 has packaged black-box evidence.
- Full Mac static/unit/build/package gates pass.
- Docs/maps/tasks/memory reflect only verified facts.
- Evidence remains ignored and unstaged.
- Closeout slice is committed.
- Final report states: changed files, verification commands, evidence paths, remaining alpha risks, and exact next step.
