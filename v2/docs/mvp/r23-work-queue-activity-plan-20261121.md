# R23 work queue and member activity implementation plan

## Boundary and dependency

This plan turns approved R23 into an executor contract. R23 implementation
depends on R17 for one stable peer shared across group memberships and R18 for
group role and duty declarations. It also depends on the selected terminal
binding exposing the exact Rex program status and capture path.

Do not use `board` as the queue owner. The board has a read-only projection
contract. Queue writes must not create a second completion truth in the board.

## Ownership

Add a minimal `v2/modules/dispatch` owner only when implementation starts. It
owns:

- work queue items;
- candidate evaluation inputs and reason records;
- read-only program-status observations;
- the user-visible dispatch decision.

It references goals and tickets for work truth. It references members for exact
binding, organization for role/duties, accounts for authorization, and
host-adapters for `program_status` and capture. It does not own target progress,
ticket state, or terminal content.

## Queue contract

`WorkQueueItem` fields:

```text
queueItemId
workspaceId
workRef
targetMemberId
targetPeerId
requiredDuties
state: queued | consumed | cancelled
enqueuedAt
enqueuedBy
```

The queue accepts an eligible busy member. Eligibility is current role, duty,
workspace, and resource authorization. Busy is not a deny condition. Enqueue
is not assignment acceptance and must not change goal/ticket owner.

Query by stable member identity returns the same queued reference after the
member reconnects in a new session. An item for a stale binding is still
queryable as queued. Revalidate current authorization for any subsequent
operation. Resolve the binding on operations that need a terminal.

## Activity observation

Extend the host observation boundary with a typed result:

```text
value: busy | idle | unknown
source: program_status | capture | unavailable
observedAt
freshness: fresh | stale | unavailable | unknown
bindingGeneration
terminalTarget
captureRef: null | exact read-only reference
errorRef
```

Rex observation order:

1. Resolve the target member's current binding and exact target.
2. Query that target pane's `program_status`.
3. If the response is missing, unsupported, or still unknown, offer a
   read-only capture reference for the same target.
4. Never infer idle from missing data.

The daemon route and host adapter must use the captured binding generation.
If the target changes while observation runs, return stale/unknown and do not
attribute the old result to the new binding.

The product does not automatically turn captured text into a business status.
An authorized agent may read the same capture and record its judgment. The
receipt must identify the exact capture reference and generation used.

## Dispatch selection

The evaluation API receives a work kind and candidates with current role,
duties, authorization, activity, and queue state.

Selection is a decision with recorded reasons, not a hidden side effect:

1. Reject candidates that fail role, duty, workspace, or resource authorization.
2. Probe activity when it is unknown for a Rex candidate.
3. Present confirmed idle as one factor among comparable candidates.
4. Keep busy and unresolved-unknown candidates eligible. They may be selected
   for other declared factors such as required role.
5. Add a queue item only for an explicit enqueue command and its chosen target.
   Evaluation alone has no queue side effects.

The result exposes each candidate's eligibility, activity basis, selected flag,
and reason. `idle` must not be the only admission condition.

## DAGs

Create `v2/docs/dagpipe/graphs/work-queue.graph.json`:

`queue request -> authenticate and resolve stable target -> check current role and duty -> enqueue without changing work owner -> publish queue item`

Create `v2/docs/dagpipe/graphs/member-program-status.graph.json`:

`status request -> authorize and resolve exact binding -> capture generation -> query program_status -> if unresolved return same-target capture reference -> publish typed observation`

Create `v2/docs/dagpipe/graphs/dispatch-evaluation.graph.json`:

`work and candidates -> filter by current authorization and role -> resolve unknown Rex status -> evaluate activity and other declared factors -> publish decision`

All three are SESE graphs. The status graph has no terminal input or lifecycle
side effect.

## Red tests before code

1. A busy member with required authority receives a queue item; the item is
   visible by stable member identity and the goal owner is unchanged.
2. Same member reconnects in a new session; the same queue item remains.
3. Rex `program_status=working` maps to busy and records exact target and
   generation.
4. Missing status returns unknown plus a capture reference for the same target.
5. A capture reference for another pane or old generation is rejected.
6. A candidate without the required duty is rejected and receives no queue
   side effect.
7. Comparable idle and busy candidates record idle as a preference; a busy
   candidate remains admissible for an additional declared factor.
8. Unknown after probe and capture remains unknown and does not become idle.

## Public observation and acceptance

Required public surfaces:

- queue create/query daemon routes;
- activity query receipt with source, generation, target, and capture reference;
- dispatch evaluation receipt with candidate reasons.

Formal acceptance needs a busy member queue case, a same-name reconnection case,
one Rex `program_status` case, one same-pane capture case, and one resolved
permission denial. Tests and static DAG validation alone are not product
acceptance.

## Executor stop conditions

Stop and return the exact missing surface if:

- R17 still keys bindings only by `memberId`;
- R18 has no readable duty declaration;
- the host adapter cannot access Rex `program_status`;
- capture cannot be tied to the same terminal target and generation;
- a proposed queue write would change goal/ticket owner or board completion.

Do not add a fallback that guesses idle or substitutes a different member.
