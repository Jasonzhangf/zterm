# App Update Version Test Design

## Lifecycle

1. A normal build `0.1.3.N` receives an Android `versionCode` at slot `N * stride` inside the configured epoch.
2. Its rollback artifact is built from the same source as `0.1.3.N.1` with `versionCode = normal + rollback_offset`.
3. Release `0.1.3.N+1` receives the next slot, which must be greater than `0.1.3.N.1`.
4. The `N+1` manifest points `rollbackToPrevious` at retained artifact `0.1.3.N.1`; it does not relabel the `N+1` payload as a rollback.
5. If a canonical build stops after allocating `N` but before publishing it, an explicit resume for expected build `N` reuses that slot; a mismatched expected build fails before any build or publication step.
6. The canonical entry prepares the current daemon release runtime before package `prebuild`, because terminal contract tests inspect that generated runtime and must not depend on an artifact left by another worktree.
7. Relay publication verifies the returned manifest as JSON and compares its numeric `versionCode`; transport formatting such as minified versus pretty JSON is not release truth.

## White-Box Gates

- Positive: normal `N`, rollback `N.1`, and normal `N+1` are strictly increasing by Android `versionCode`.
- Positive: rollback display version physically ends in `.1` in the APK manifest.
- Negative: the old bit-30 rollback code is below the new epoch, so the first corrected normal release can replace it.
- Negative: a release must not publish its own payload as `rollbackToPrevious`.
- Positive: explicit resume preserves the already allocated build number without rewriting `.build-meta.json`.
- Negative: resume rejects a missing, malformed, or mismatched expected build number instead of allocating another slot or continuing ambiguously.
- Positive: a clean worktree generates its daemon release runtime before `pnpm build` starts the terminal contract gate.
- Negative: package `prebuild` never reads a stale or ambient daemon release artifact as a prerequisite for generating the current one.
- Positive: pretty and minified Relay manifests with the expected numeric `versionCode` both pass the same semantic verifier.
- Negative: malformed JSON and a different `versionCode` fail publication even when the HTTP transfer itself succeeds.
- Boundary: computed codes remain within Android's signed 32-bit `versionCode` limit.

## Module Black-Box Gates

- Build both Gradle variants and inspect each with `apkanalyzer manifest version-name` and `apkanalyzer manifest version-code`.
- Install normal `N`, then rollback `N.1`, then normal `N+1` without `adb install -d`; all three installs must succeed.
- Verify `latest.json` normal and rollback fields match the APK manifests and hashes.
- Interrupt the canonical entry after allocation, resume it with the exact expected build number, and verify the normal APK, rollback APK, local OTA manifest, and Relay manifest all retain that build number.

## Known Migration

The previous bit-30 scheme made every later normal build numerically lower. The corrected epoch starts above that shipped value. This is a one-way version-code namespace migration; display versions keep the existing `0.1.3.N` / `0.1.3.N.1` contract.
