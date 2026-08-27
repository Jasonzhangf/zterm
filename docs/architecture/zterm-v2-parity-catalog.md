# ZTerm v2 parity catalog

`zterm-v2-parity-catalog.json` is the Phase 0 machine-readable baseline for Android, macOS, and Windows production behavior. It is an admission artifact, not a claim that every v1 feature is currently runtime-verified.

## Baseline

- Production commit: `e7ca090bea4590c95b38765a5b6fbd7c2b50443c`
- Inspection worktree HEAD: `210b98e2a378bb96a96d9efc88e6ca8ecd8e6e53`
- Feature count: 75
- Platform IDs: `android`, `macos`, `windows`
- Verification profiles: Android source/package, macOS packaged alpha, Windows packaged alpha, and cross-platform workspace.

Android registry features retain their stable `feature_id` and resolve owners through `android/docs/feature-registry.json`. macOS and Windows-only slices bind directly to owner paths from their function maps. Every entry records entrypoint surface/paths, business payload semantics, lifecycle, errors, verification profile, and current status.

## Status rule

`verified` means a referenced file or ownership binding exists in this inspected tree AND a current baseline command or durable evidence artifact was verified. `pending` means the required gate was not yet executed in the current baseline. `blocked` means an external dependency prevents execution.

### Android profile (`android_v1`) — VERIFIED by T2

- type-check: PASS
- feature-registry: 102/102 PASS
- Gradle build: BUILD SUCCESSFUL
- emulator 0.1.3.2760: foreground, no FATAL/ANR; dataDir/firstInstallTime preserved
- OTA 2760: local+Tailscale manifest sha256 `ab4e54e9...` verified
- rollback 2760.1: sha256 `0db0b530...` prepared
- daemon /health: ready; server.cjs sha `dba91008...` matches main
- Public Relay: remains 2747; 2760 returns 404 (out of scope)

### macOS profile (`macos_v1`) — VERIFIED by T1+T3

- type-check: PASS
- build: PASS
- package: PASS
- terminal-buffer-blackbox: PASS sequence/TUI/large-reading; launch exit 0; signature verify 0; process/port cleanup empty
- AGY review: PASS findings=[]

### Windows profile (`windows_v1`) — PENDING (Phase 2)

- deferred to Phase 2; no live evidence required in this baseline.

### Cross-platform workspace — VERIFIED (Android+Mac) by T1+T2+T3

- Android workspace tests: part of T2 regression suite 861/861 PASS
- Mac workspace tests: T1 merged 5b294a01 fixes split-tree arity; T3 full whitebox 23 files/167 tests PASS
- Windows workspace: deferred to Phase 2.

Individual feature rows remain `pending` because this reconciliation does not rerun every feature-level gate; profile-level Android and macOS gates are updated to `verified` only.

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
