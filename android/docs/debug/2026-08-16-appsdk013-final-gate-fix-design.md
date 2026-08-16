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
