# Loop Governance Test Design

## Scope

Feature: `project.loop_governance`

This design covers the initialized `zterm.daily-triage` loop. The current mode is `L1 report-only`; no runner, daemon action, product-code fix, commit, push, or merge is enabled by this slice.

## Lifecycle Path

```text
start run
-> read loop files
-> check kill switch
-> check budget
-> read project maps
-> inspect allowed report-only sources
-> bind findings to feature_id / owner / gate / mainline_call_id
-> append run-log entry
-> stop
```

## White-Box Tests

- Parse `docs/loops/loop-manifest.json`.
- Verify every canonical doc and verification gate path resolves.
- Verify manifest `owner_feature` exists in `docs/feature-registry.json`.
- Verify `project.loop_governance` exists in `docs/function-map.md` and `docs/feature-gates.md`.
- Verify L1 action flags deny product code edits, daemon start/stop, stage/commit, push, and merge.
- Verify required report fields include `feature_id`, owner path, required gate, status, and `mainline_call_id`.
- Verify every manifest `mainline_call_id` exists as an `edge_id` in `docs/wiki/mainline-call-map.json`.
- Verify every mainline call-map edge has a unique deterministic `edge_id` of `<lifecycle_id>:<from>-><to>`.
- Verify `STATE.md` initializes with `mode: L1` and `kill_switch: inactive`.

## Module Black-Box Tests

- Kill switch active fixture: a loop run must no-op and must not inspect product surfaces.
- Clean repo fixture: no findings should produce `outcome: no-op`.
- Dirty worktree fixture: untracked or modified files should be reported only; no stage, delete, checkout, or cleanup action is allowed.
- Invalid manifest path fixture: loop validation must fail explicitly.
- Invalid `mainline_call_id` fixture: loop validation must fail explicitly, not downgrade to a warning.
- L1 action request fixture: any requested edit/start/commit action must be rejected because `actions_allowed` marks it false.

## Project Black-Box Impact

- `test:feature-registry` must include `src/lib/loop-governance-truth.test.ts`.
- The initialization must not start daemon, run Android build, install APK, or touch `mac/evidence/**`.
- Runtime terminal behavior is out of scope; this slice proves only L0 governance.

## Known Gaps

- No scheduled runner is enabled.
- No L2 maker/checker execution path is enabled.
- No L3 unattended mode is enabled.
- No browser or device smoke is required because this slice changes governance docs and static gates only.
