# R22 inspection scope and continuity implementation plan

## Boundary

This plan turns approved R22 into an executor contract. It does not change the
clause to enforced. Implementation waits for the R21 reminder scheduling and
actual-delivery settlement surfaces because R22 must not create a second
product scheduler.

Input tree: `/Volumes/Intel/playground/zterm/worktrees/mvp-ontology-review-20261121`.
The current tree has no `v2/modules/inspections` product owner or daemon route.
Existing organization manager membership is not sufficient to prove R22 group
duty scope.

## Business contract

An inspection subscription owns these durable facts:

- `subscriptionId`, `workspaceId`, `targetRef` (`goalId` or ticket reference).
- Current `ownerMemberId` and declared management scope.
- `intervalMs`, `remainingCount`, `logRef`, `state`, and next due time.

The subscription never stores a second completion truth for a goal or ticket.
Every execution reads the live target and child work owners.

## Authorization graph

Create `v2/docs/dagpipe/graphs/inspection-scope-management.graph.json` as one
SESE graph:

`management request -> authenticate actor and resolve exact member identity -> load live target and R18 group duties -> authorize self / group / explicit CEO scope -> commit create, update, cancel, or renew -> public projection`

The relation gate rejects:

- an actor who is not the current target owner using the self scope;
- a group manager outside the target group or outside declared inspection duty;
- a CEO without an explicit stored cross-scope grant;
- an unknown, cross-workspace, or terminated target;
- a renewal after the duty no longer authorizes the target.

The same graph owns mutations. HTTP adapters and WebUI may only serialize and
project its result; they cannot make a second authorization decision.

2026-11-22 topology acceptance: `inspection.scope.management@0.2` validates and
inspects as one input and one output. Authentication rejection bypasses
subscription access. The authenticated path resolves caller, target, current
duty, manager relation and stored CEO grant, then emits one mutually exclusive
decision for scope, target lifecycle, and operation/renewal authorization. Only
the authorized decision reaches the single subscription commit. This accepts
static topology only; runtime compile, public mutation route, persistence,
legal and illegal cases, WebUI and independent product acceptance remain open.

## Execution graph

Create `v2/docs/dagpipe/graphs/inspection-run.graph.json` as one SESE graph:

`due occurrence -> revalidate target, actor duty, and current owner -> query live goal/ticket progress, severe defects, child work, delivery gaps, and owned resources -> append one dated entry to the same log -> settle remainingCount -> publish execution result`

An actual completed run records one log entry and settles one occurrence.
Preserve the original error for an incomplete run. The approved clause specifies
count continuity across restart. Whether a partially executed, failed inspection
consumes one occurrence is open. Leave that decision explicit in the graph
contract and defer the affected settlement branch.

Restart must recover the same occurrence before creating a new one. An
interrupted execution is unknown until the log and target reads are reconciled.
When target completion or cancellation is observed, future ticks stop and the
subscription becomes terminal without rewriting prior log entries.

## Red tests before implementation

1. Target owner creates and executes a self inspection; the response and public
   query expose subscription, log, one execution result, and decremented count.
2. A group manager with declared inspection duty manages an in-scope target.
3. The same manager is denied for another group, with no subscription mutation.
4. A CEO without an explicit cross-scope grant is denied across groups.
5. Restart with 37 remaining uses the original subscription and log; one actual
   execution leaves 36.
6. Target completion stops future ticks and preserves history.
7. A query failure returns the original error. Record the observed execution
   stage so the approved settlement policy can be tested when available.

These are module contract tests first. Formal acceptance still requires the
daemon public route, real target sources, persistent restart, and WebUI paths.

## Public observation

Executor must expose:

- daemon route for create/query/update/cancel/renew;
- execution occurrence query with exact target, authorization basis, outcome,
  log reference, and remaining count;
- WebUI list/detail view for subscription, log, errors, and remaining count.

Legal and illegal HTTP receipts must use the same route and same target shape.
Module tests and static graph validation are not product acceptance.

## Owner map

- `inspections`: subscription, occurrence, log settlement, and public port.
- `accounts`: authentication and actor authorization.
- `organization`: exact group member, group role, duties, and manager relation.
- `goals` and `tickets`: live target and child work truth.
- daemon composition: scheduling and public route composition.
- `webui`: visible configuration and result projection.
- Independent tester: desktop and mobile public-path acceptance.

Implementation owner must not alter R19 assignment semantics or R21 reminder
settlement. If a needed R21 surface is absent, stop that part and return the
exact missing producer and consumer.
