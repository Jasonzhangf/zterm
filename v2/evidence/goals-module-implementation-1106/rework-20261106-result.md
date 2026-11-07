# Goals null-name rework result

## Result

Public `updateGoal` now treats only `undefined` as an omitted name. An explicit
name must be a non-empty string. `null`, an empty string, and a whitespace-only
string reject with `GOAL_INVALID_NAME` before `store.update`.

The rejection has no business side effect. The original goal remains readable
through `getGoal` and `listGoals`. A legal rename remains readable through
`getGoal`, and the existing reopen contract test still passes.

## Verification

- Red test: `node --test v2/modules/goals/tests/contract/goals.test.mjs`, exit 1.
  The new test failed with `Missing expected rejection.` before the fix.
- Green test: `node --test v2/modules/goals/tests/contract/goals.test.mjs`, exit 0; 6/6 passed.
- Syntax: each `node --check` listed in `syntax-checks.txt`, exit 0.

## Evidence

- `rework-20261106-graph.md`
- `red-test.txt`
- `green-tests.txt`
- `syntax-checks.txt`
- `changed-paths.txt`

## Scope and boundaries

Changes are limited to `v2/modules/goals/**` and
`v2/evidence/goals-module-implementation-1106/**`. The change preserves the
single-writer file-store contract. It adds no file lock, additional store, or
global registry. It does not touch another module, shared daemon, tmux server,
device, or network service. It does not push, merge, publish, or create a PR.

## Remaining work

No implementation blocker remains. Delivery, integration, and task closure stay
with Jenny. The independent finding review stays with David.
