# ZTerm v2 parity catalog

`zterm-v2-parity-catalog.json` is the Phase 0 machine-readable baseline for Android, macOS, and Windows production behavior. It is an admission artifact, not a claim that every v1 feature is currently runtime-verified.

## Baseline

- Production commit: `d0f17b709873a7b4571b00f2ce32f428aae1b6ae`
- Inspection worktree HEAD: `210b98e2a378bb96a96d9efc88e6ca8ecd8e6e53`
- Feature count: 75
- Platform IDs: `android`, `macos`, `windows`
- Verification profiles: Android source/package, macOS packaged alpha, Windows packaged alpha, and cross-platform workspace.

Android registry features retain their stable `feature_id` and resolve owners through `android/docs/feature-registry.json`. macOS and Windows-only slices bind directly to owner paths from their function maps. Every entry records entrypoint surface/paths, business payload semantics, lifecycle, errors, verification profile, and current status.

## Status rule

`verified` means a referenced file or ownership binding exists in this inspected tree. It never means a command was rerun. Commands, packaged smoke scripts, device/live samples, and durable evidence paths are explicitly `pending` because:

1. committed platform evidence directories contain README files only;
2 historical macOS/Windows smoke results are recorded in task/MEMORY prose but their evidence artifacts are absent from the current tree;
3. no installed APK/app/package identity was captured in this clean worktree.

Therefore all 75 feature rows remain overall `pending`. This is intentional and prevents target-state or stale historical claims from entering Phase 1 as production facts.

## Gate

Positive gate:

```bash
pnpm run test:v2-parity-catalog
```

Negative duplicate/unknown-reference fixture:

```bash
pnpm run test:v2-parity-catalog:negative
```

The validator parses JSON, rejects duplicate feature/platform IDs, resolves Android registry feature IDs, verifies direct owner and entrypoint/test/script paths, requires behavior/error/lifecycle fields, and requires each profile to state its runtime evidence gap.
