# R21 Reminder Binding Implementation Contract

## Goal

Close the approved R21 reminder binding gap in the mainline architecture. This
design defines the reminder subscription, sender/initial receiver registration,
periodic occurrence settlement, late-read behavior, busy/offline skip, and
current owner routing that R21 and its approved subclauses require.

This is an implementation design. It does not bind R21 in the ontology, claim a
product pass, implement the code, or issue final review.

## Dependencies

R21 follows R19. The accepted R19 assignment commit is the source of the
current owner. This design must not create a second owner truth.

The historical reminder worktree is evidence only. It does not establish that
mainline has a reminder module, daemon route, gate, or two-machine delivery.

## Existing Gap

- Mainline has no `v2/modules/reminders` implementation or reminder daemon
  route.
- Historical `recordConsumption` decrements a finite subscription.
- Historical offline recipients remain in `waiting-recipient`.
- Historical subscription registration lacks separate stable sender and
  initial receiver fields.

The committed current owner must remain the routing input for every new
occurrence. Registration fields are immutable facts and must not be rewritten
by later owner transfer.

## Objects and Ownership

- `reminder_subscription` owner: reminders.
  - stable `subscriptionId`
  - `targetRef` and `targetType`
  - registered sender member ref
  - initial receiver member ref
  - schedule, interval, remaining count, expires at, state
  - current-owner projection from the work owner
- `reminder_occurrence` owner: reminders.
  - original scheduled time and planned slot
  - outcome: `delivered`, `skipped`, `failed`, or `unknown`
  - reason for skip or failure
  - delivery ref for correlation with the delivery owner's actual send outcome
  - consumption ref only after actual read evidence
- delivery owner: message acceptance, attempt, and actual send fact.
- organization/accounts owner: current sender permission and member identity.
- goals/tickets owner: current work owner.
- daemon composition owner: tick execution, current permission checks, and
  startup recovery.
- WebUI owner: subscription and result projection.

No reminder code may write owner into goals/tickets or synthesize a successful
delivery when the actual dispatch was not admitted.

## Required Scheduling Semantics

The scheduled timeline is fixed when the subscription is created. It is not
derived from a previous read or delivery time.

At each due tick:

```text
due occurrence
  -> resolve current work owner by stable member identity
  -> verify registered sender identity and current permission
  -> probe current recipient availability
       busy or offline -> persist skipped occurrence, no delivery, no count decrement
       available -> dispatch through delivery owner
            actual send confirmed -> persist delivered occurrence and decrement once
            send failed or unconfirmed -> persist failed/unknown occurrence, no decrement
  -> leave next scheduled time unchanged from the original timeline
```

Settle a finite occurrence once using its original scheduled slot and delivery
reference. A local `accepted/pending` receipt or replay of that receipt leaves
the count unchanged. A repeat observation of a confirmed send leaves the
count at the value already settled for that slot.

The delivery service exposes `queryReceipt(actor, DeliveryRef)`.
`resumeDispatch` recognizes `remote-stored`, `host-delivered`, and `consumed`
as durable evidence of prior dispatch. This gives the executor a receipt
path to verify. Trace the configured reminder transport from dispatch to the
recipient and identify its first observable stage that proves actual send.
Record that stage and its public observation in the gate contract. Confirm
the unread case before using any later consumption observation.

Recovery must also cover the window after a side-effectful dispatch but before
the reminder count settlement commits. Before dispatch, the reminder occurrence
persists the original request identity. After a restart, it uses that identity
and the original sender authorization to find the same delivery result. A
confirmed send settles once and decrements once; an inconclusive result keeps
the occurrence `unknown` with its original delivery reference and does not
decrement or dispatch again. A later read still updates only the consumption
record.

Late read:

```text
delivered to recipient inbox, user not yet read
  -> remaining count already decremented once at actual send

read at a later time
  -> record consumption only
  -> no count decrement
  -> no reschedule
  -> no second notification
```

The sender/initial receiver fields are registration facts. A committed owner
transfer changes only the resolution of the next not-yet-created occurrence.
Existing message refs, targets, deadlines, and attempts remain unchanged.

## Availability Decision

The recipient availability used for a periodic occurrence is one of:

- `idle`
- `busy`
- `offline`
- `unknown`

Only `idle` proceeds to dispatch. `busy` and `offline` persist `skipped`.
`unknown` must not be converted to `idle`; it remains `unknown` unless a
declared observation path provides a stronger result.

For Rex, the declared source is the target binding pane's `program_status`.
When that observation is inconclusive, an agent may read `capture` from the
same pane and record its judgment. The capture is evidence for the agent's
decision, not a second online/offline truth owner. Missing evidence remains
`unknown`.

## DAG Design

`reminder-occurrence.graph.json` uses a single tick input and a single outcome
output. Recovery precedes any decision to send again:

```text
tick -> load original slot and request identity
  -> already settled: replay without mutation
  -> unsettled: read dispatch record by original identity
       -> existing confirmed: project confirmed-send fact
       -> existing unconfirmed or inconclusive lookup: no new send or debit
       -> proven absent: check current sender permission
            -> denied: typed failure, no recipient probe
            -> allowed: resolve and probe current recipient
                 -> busy/offline: skip; unknown: hold unknown
                 -> idle: dispatch once
                      -> confirmed: project confirmed-send fact
                      -> failed/unknown: no debit
  -> only confirmed-send facts enter the shared atomic settlement
  -> publish one outcome without changing the original schedule
```

Do not let the graph mutate registration facts or the original schedule.
Do not model a waiting-recipient terminal for a periodic busy/offline tick.
Do not add a task-reminder scheduler into the existing goals/tickets graph.

## Gate Design

The gate must drive the public tick/query path, not a private helper. It must
cover the five user-requested red directions and the sender/receiver accent:

1. Actual send but no read yet: remaining count is one lower.
2. Offline recipient: occurrence is `skipped`, not `waiting-recipient`.
3. Late read: remaining count and next scheduled time stay unchanged.
4. Busy or offline skip: no count decrement.
5. Next cycle: the original schedule is used and the next state is evaluated
   at that time.
6. Registered sender and initial receiver are separately queryable and are not
   replaced by the creator, daemon, or fixed operator account.
7. Sender permission revoked after registration: no send and a typed failure.
8. A committed owner transfer changes only later new occurrences.

Required observations:

- public subscription detail with sender, initial receiver, remaining count,
  expiry, and original schedule
- public occurrence query after each tick
- delivery receipt for actual send
- zero submissions and unchanged count for a slot skipped before dispatch
- original request identity and unchanged count while dispatch is inconclusive
- same next-scheduled-at before and after late read
- typed sender permission failure
- recovery of one already-dispatched occurrence across a restart before count
  settlement, with the original delivery reference preserved and no duplicate
  recipient message

## Smallest Failure-First Test Set

Write red tests before implementation:

1. Decrement on `recordConsumption` instead of actual send.
2. Offline returns waiting-recipient or creates a pending message.
3. Read causes a second decrement or changes the schedule.
4. Busy/offline tick decrements remaining count.
5. Sender/initial receiver are inferred rather than explicitly registered.
6. Sender permission revocation still dispatches.
7. Unaccepted invitation routes the next occurrence to the invited member.

## Implementation Boundaries

The minimum implementation may:

- add a reminders module with durable subscription/occurrence records
- add a daemon composition route for create/query/cancel/tick
- use the existing delivery owner for actual sends
- use existing organization/member lookup and R19 assignment owner read
- use the existing Rex observation surface for `program_status` and, if
  needed, `capture`

It must not:

- duplicate the owner truth in reminders
- mutate original schedule from reads, retries, or delivery time
- add wait-for-recipient periodic behavior
- rewrite sender or initial receiver registration
- create an auto-renewal path for the responsible agent
- treat an inbox insert or delivery receipt as work completion
- modify the R10 task or its resources
- implement R22 patrol management in the R21 threshold

## Executor Deliverables

The executor result must include:

- source changes under the reminders/delivery/daemon composition owners
- the occurrence graph
- public tick and subscription query tests
- red and green evidence
- graph validation and affected test results
- proof of zero submissions for skipped slots and preserved request identity
  during uncertain delivery, with the count held in both cases
- proof that late read changes only consumption
- proof that R19 current owner routing is consumed without a second ownership
  store
- a cleanup receipt for test processes, sockets, ports, and state directories

Final review, ontology status transition, formal two-machine acceptance, and
merge/push belong to separate owners.

## Admission Conditions

R21 cannot move from `binding_pending / implementation_pending` to bound until:

- the occurrence graph validates and has a real consumer binding
- its legal and illegal cases are executed through the public tick path
- the sender/initial receiver fields are publicly queryable
- current-owner routing consumes the R19 committed owner
- the result is independently reviewed

Local module tests or a historical worktree report do not satisfy these
conditions.

2026-11-22 topology acceptance: `reminders.occurrence.settle@0.1` validates
with 19 nodes, 28 edges and 9 waves. Settled replay bypasses new dispatch. For
an unsettled occurrence, dispatch lookup is exclusive. Only proven absence
leads to current sender permission and recipient availability. Confirmed
historical and new sends become separate facts, then enter one settlement
operator that debits the original slot once. Non-confirmed outcomes bypass
settlement. The graph has one tick input and one public response output.

This accepts static topology only. Runtime compile, daemon delivery
composition, full authorized `DeliveryRef` retrieval, occurrence persistence,
public tick/query, actual send observation, restart recovery, legal and illegal
runtime cases, WebUI and independent product acceptance remain open. The graph
is not a forced R21 gate and does not change the ontology status.

## Read-Only Receipt Readiness Handoff

The board and `r21-readiness/task.md` identify the current designated executor
and the conditions for starting the source observation.

Inspect the current delivery module, daemon composition and WebUI client for
one public path that correlates a reminder occurrence slot with an actual send
outcome. Start at `queryReceipt`, `resumeDispatch`, the receipt store and the
daemon's delivery route. Identify the delivery stage that proves the message
left the submitting side and distinguish it from local `accepted/pending`,
remote storage, host display and recipient read.

Return a file-backed readiness report containing:

- the exact public HTTP or WebUI entry to submit a message;
- how a caller obtains its `DeliveryRef`;
- the query entry and actor scope required to read it;
- the first stage that proves actual send for the real configured transport;
- how an unread state is distinguished from consumed;
- how the same reminder occurrence can be correlated to the receipt without
  deriving count changes from log text;
- which of these paths actually exist in the audit candidate and which are
  missing;
- one legal probe, one replay/no-double-decrement probe, and one unavailable
  or failed-send probe for later public execution.

Do not use a local `accepted` response, an inbox insert, a test double, or a
historical reminder candidate as proof of actual send. Do not modify source or
claim R21 acceptance. Return the report path and exact blockers to the
architect.

## Receipt boundary in the audit worktree

The first positive mapping in `delivery/src/adapters/connections-dispatch.ts`
is an awaited result with both `status` and `stage` equal to `received`.
It produces `remote-stored`, which confirms target gateway storage. The
receipt can still be unread. The delivery owner retains an inconclusive wire
result as `unknown`. Its read port authorizes the caller for the exact
`DeliveryRef` before reading the store.

The WebUI client submits through `delivery.submitMessage` and queries
`delivery.queryReceipt` with `messageId`. The delivery module queries by
`sourceMachineId`, `workspaceId`, `actorAccountId` and `requestId`. The audit
found no bridge in `daemon/src/server.mjs` between those requests and the
delivery port. The real reminder transport and unread send observation thus
remain unverified.

For the executor, carry the ref returned by submission on the occurrence for
its original slot. Exercise a real send while the recipient leaves the
message unread. Query the same ref and read back the remaining count. Repeat
the query and later consume the message. Both observations must preserve the
count settled on the first confirmed send and the original next due time.
Exercise a busy or offline slot separately and verify a skipped occurrence,
zero submissions and an unchanged count. Capture the next scheduled slot's
fresh availability decision. Delivery owns the receipt, reminders owns
settlement, and the daemon composition owner supplies the public adapter.

Use an isolated clock and state store for the interrupted-settlement gate.
Start with two sends remaining on a five-minute schedule. At 10:00 the
recipient is offline. Observe a skipped slot and two sends remaining. Bring
the recipient online at 10:02 and check that the inbox stays empty. At 10:05
observe one unread message on the receiver, interrupt the test instance before
reminders commits settlement, and recover with the original actor and request
identity. Observe one message, the same delivery and one send remaining.
Recover again and read at 10:06. Verify consumption, one send remaining and
the next slot at 10:10. A lost submit response may leave only the request
identity available. The readiness report must identify how delivery resolves
that identity with current authorization before this gate can run.
