# Goals module implementation run note

- Goal: implement the V2 goals module public CRUD and persistent capability required by I3.
- Baseline: `v2/modules/goals` has only `DESIGN.md`; `v2/docs/dagpipe/graphs` has no Goals graph.
- Scope: only `v2/modules/goals/**` and this evidence directory.
- Acceptance: public create/get/list/update; stable IDs; persisted readback; workspace denial;
  same-parent name conflict; invalid hierarchy/owner; referenced-goal deletion protection.
- Current state: DAG gap recorded in `graph.md`; contract red test is the next step.
Current state: public goal service implemented; 5/5 contract tests green; `node --check` passes for all new mjs files; red/green/syntax evidence written under `v2/evidence/goals-module-implementation-1106/`.
Next step: hand back to worker owner for David review; no push/merge in this task.
- Constraints: no shared service, port, tmux, device, push, merge, publish, or Git integration.

## Rework 2026-11-06

- Goal: reject explicit `name: null` in public `updateGoal` without changing the existing goal.
- Finding: `requireOptionalString` accepted `null`; `resolvedName` then persisted `null` and `listGoals` could fail at `localeCompare`.
- Owner: `v2/modules/goals/src/application/goal-service.mjs` update boundary.
- Result: added `GOAL_INVALID_NAME`; `undefined` keeps the old name; `null`, empty, and whitespace-only provided names reject before `store.update`.
- Evidence: `rework-20261106-graph.md`, `red-test.txt`, `green-tests.txt`, `syntax-checks.txt`, and `rework-20261106-result.md`.
- Next: hand off to Jenny for delivery, then David for independent finding review.
