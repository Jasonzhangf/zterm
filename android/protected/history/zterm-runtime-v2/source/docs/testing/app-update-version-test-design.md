# App Update Version Test Design

## Lifecycle

1. A normal build `0.1.3.N` receives an Android `versionCode` at slot `N * stride` inside the configured epoch.
2. Its rollback artifact is built from the same source as `0.1.3.N.1` with `versionCode = normal + rollback_offset`.
3. Release `0.1.3.N+1` receives the next slot, which must be greater than `0.1.3.N.1`.
4. The `N+1` manifest points `rollbackToPrevious` at retained artifact `0.1.3.N.1`; it does not relabel the `N+1` payload as a rollback.

## White-Box Gates

- Positive: normal `N`, rollback `N.1`, and normal `N+1` are strictly increasing by Android `versionCode`.
- Positive: rollback display version physically ends in `.1` in the APK manifest.
- Negative: the old bit-30 rollback code is below the new epoch, so the first corrected normal release can replace it.
- Negative: a release must not publish its own payload as `rollbackToPrevious`.
- Boundary: computed codes remain within Android's signed 32-bit `versionCode` limit.

## Module Black-Box Gates

- Build both Gradle variants and inspect each with `apkanalyzer manifest version-name` and `apkanalyzer manifest version-code`.
- Install normal `N`, then rollback `N.1`, then normal `N+1` without `adb install -d`; all three installs must succeed.
- Verify `latest.json` normal and rollback fields match the APK manifests and hashes.

## Known Migration

The previous bit-30 scheme made every later normal build numerically lower. The corrected epoch starts above that shipped value. This is a one-way version-code namespace migration; display versions keep the existing `0.1.3.N` / `0.1.3.N.1` contract.
