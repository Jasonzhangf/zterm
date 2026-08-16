# AppSDK 0.1.3 final gate fix design

Design ID: `FD-20260816-APPSDK013-FINAL-GATE-01`

## Symptom

`pnpm run prebuild` on final migration branch `fe29d34` fails two gates:

- `src/lib/lifecycle-contract-truth.test.ts`: goal clarification state declares
  `superseded` but no transition reaches it.
- `src/lib/feature-registry-truth.test.ts`: `forbidden_paths` entries
  `../wterm/` fail because the external runtime repo is not a sibling in an
  isolated worktree or CI checkout.

## First divergence

1. Migration commit `1684f27` replaced the project-specific goal state machine
   with the AppSDK 0.1.3 scaffold and removed
   `admitted -> superseded`. The project record schema still allows
   `superseded`, and the project test requires every declared state reachable.
2. The feature registry gate was written for the main checkout layout and
   requires every forbidden path to exist. `../wterm/` is intentionally
   external, so isolated worktrees and CI cannot satisfy the existence check.

## Evidence

- Baseline in `.worktree-appsdk-013-v4/android`: both tests fail as above.
- Baseline in experiment worktree `/Volumes/extension/code/zterm-appsdk013-debug-final-20260816T0639`
  (sibling to `wterm`): feature registry passes, lifecycle gate still fails.
- Positive intervention: adding `admitted -> superseded` makes the lifecycle
  gate pass; removing it restores the failure.
- Positive intervention: allowing exactly `../wterm/` as an absent external
  boundary makes the feature gate pass; removing that handling restores the
  failure.

## Formal fix scope

- `android/contracts/goal-clarification-state-machine.json`: restore
  `{"from":"admitted","to":"superseded","requirements":["replacement_goal_id","supersession_record"]}`.
- `android/src/lib/feature-registry-truth.test.ts`: keep internal forbidden
  paths required to resolve; allow only the known external boundary
  `../wterm/` to be absent.
- `android/scripts/run-file-transfer-throughput-gate.sh`: build the web bundle
  and run `npx cap sync android` before the Gradle unit test, so a fresh
  checkout/CI tree does not fail on the ignored
  `native/android/capacitor-cordova-android-plugins` directory.

## Owners

- Goal clarification contract and lifecycle truth gate: AppSDK project
  governance contract surface.
- Feature registry truth gate: project governance gate surface.
- File-transfer throughput build gate: project build gate surface owned by
  `zterm-runtime-v2` (`scripts/**`).

## Required verification

1. `appsdk begin-version` for the frozen module before source edits.
2. Targeted red/green: lifecycle and feature registry tests.
3. `appsdk verify .`.
4. Full `pnpm run prebuild` and `pnpm run build`.
5. Final DSH source review after lifecycle records are updated.
6. Do not publish OTA or merge to main without separate Jason approval.

## DSH final review round 2 (2026-08-16)

Symptom: `zarchv2-activev4-final-9f653d8-20260816T173500Z` returns
`VERDICT: FAIL` with reproducible P0/P1 findings on the candidate that claimed
all gates green.

First divergence:

- `vi.spyOn(window.localStorage, 'setItem')` does not install an own method on
  the jsdom Storage instance, so the quota-exceeded test still reaches
  `StoragePermissionPlugin.openFile`.
- `src/vitest.setup.ts` was assigned to `shared.test_contracts`, which owns
  registry-truth gates, not generic test environment bootstrap.
- `Storage.prototype.removeItem` in `useOpenTabRuntime.test.tsx` remains the
  same fragile pattern that can no-op on the target Node/jsdom runtime.
- `session-render-buffer-store.test.ts` measures a full 80k-cell clone on a
  loaded machine; the hard 16ms guard flakes even with warmup.

Formal fix scope:

- `src/vitest.setup.ts`: always install a deterministic in-memory
  `window.localStorage` so tests spy the exact Storage instance under test.
- `src/hooks/useOpenTabRuntime.test.tsx`: spy `window.localStorage.removeItem`
  instead of `Storage.prototype.removeItem`.
- `docs/module-registry.json`, `docs/resource-registry.json`, and
  `docs/modules/project-modules.md`: add `shared.test_environment` /
  `resource.shared_test_environment` as the genuine test-environment owner.
- `src/lib/session-render-buffer-store.ts`: keep a per-session source-row
  clone cache. Unchanged rows (same row array reference) reuse their previous
  deep clone; changed rows arrive as new row arrays and are cloned once.
- `src/lib/session-render-buffer-store.test.ts`: measure realistic incremental
  publishes with changed rows replaced by new row references, and add a red
  test proving unchanged source rows are not read or cloned again.

The 16ms hard threshold is unchanged.

## DSH final review round 3 (2026-08-16)

Symptom: `zarchv2-activev4-final-6ae9528-20260816T192400Z` returns
`VERDICT: FAIL` with one P1 and three P2 findings.

First divergence:

- The immutable branch wrote `source row -> source row` identity entries into
  the per-session cache, and `cloneRenderBuffer` also reused the previous
  snapshot row directly. A session that mixed immutable then non-immutable
  publishes could alias live source rows into the stored render snapshot.
- The perf test measured only one changed row per publish, so removing the
  whole source-row cache would still pass the 16ms guard.
- The regression report referenced the old compile commit and did not list the
  changed suites.
- The immutable production hot path allocated and retained identity cache
  entries for the session lifetime.

Formal fix scope:

- `session-render-buffer-store.ts`: remove the per-session source-row clone
  cache entirely. Non-immutable publishes always clone rows, gap ranges, and
  cursor because the previous snapshot may have been an immutable projection
  that aliases live source data. Immutable production publishes do not allocate
  a per-commit rows-length `Map`.
- `session-render-buffer-store.test.ts`: keep the mixed-mode test proving a
  non-immutable publish after an immutable publish does not alias the live
  source row, gap ranges, or cursor. Move the 16ms timing guard onto the real
  production projection path by publishing with `immutableProjection: true`.
- The 16ms timing guard is unchanged.
- `tmp-perf-bench.test.ts` is removed before the candidate commit.
