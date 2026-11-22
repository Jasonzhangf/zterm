# R20 exact handoff query implementation plan

## Boundary

This plan covers the first R20 implementation increment: make one accepted
assignment invitation queryable by its original reference after later work
owner changes. It does not implement the full cross-module reconcile port.

R20's `partial` and `unknown` recovery surface still requires delivery and
reminder effects. This increment is the durable goals-side relationship needed
by that later composition.

Implementation is blocked while Alice owns the goals R19 write surface. The
next executor must start only after the R19 task releases those files.

## Current gap

`assignmentProjection` returns only the newest invitation. It sorts by
`createdAt` and keeps the first item. The persisted earlier invitation remains,
but no public HTTP route reads it by `invitationId`.

After A transfers to B, B renames the goal, B transfers to C, and C transfers
back to B, the current assignment correctly shows B and the newest invitation.
The first accepted A-to-B invitation cannot be observed through a read-only
public path.

## Data contract

Add `committedGoalRevision` to an invitation at acceptance. Set it inside the
same `store.update` callback that changes `goal.ownerMemberId` and invitation
state. This records the goal revision produced by that exact acceptance.

Exact invitation projection:

```text
invitationId
workspaceId
goalId
ownerMemberId
invitedMemberId
state
createdAt
acceptedAt
committedGoalRevision
```

On acceptance, goals also sets the current assignment's
`currentAcceptedInvitationId` to the exact invitation in that same update.
Return both the requested invitation and that pointer from one authorized
read. Ordinary edits and pending invitations preserve the pointer. Historical
records lacking reliable commit provenance expose unknown. A recovery write
requires a fresh authorization check at the effect owner. Neither the latest
invitation creation time nor a general goal revision establishes this fact.

## Public route

Add:

```text
GET /api/workspaces/{workspaceId}/goals/{goalId}/assignment/invitations/{invitationId}
```

The daemon owns authentication and route parsing. Goals owns exact lookup and
scope validation. The route must require the same workspace read access as
`queryAssignment` and must not mutate state.

Unknown IDs and invitations from another workspace or goal return the existing
typed not-found error. The response never falls back to the latest invitation.

## Query DAG

Create `v2/docs/dagpipe/graphs/handoff-query.graph.json` as one SESE graph:

`request -> authenticate and authorize workspace read -> load exact invitation by original reference -> load current assignment projection -> publish historical commit and current authority`

The gate is a read-effect gate: it rejects mutation and cross-workspace lookup,
and its public observation is the GET response.

## Red tests before code

1. A invites B and B accepts. GET by the exact invitation ID returns accepted,
   non-null `acceptedAt` and `committedGoalRevision`.
2. B renames the goal. GET goal keeps the new name and incremented revision.
   GET assignment still reports B and the accepted invitation.
3. B invites C and C accepts. C invites B and B accepts. GET by the first
   invitation ID still returns the exact A-to-B acceptance and its original
   commit revision, while current assignment reports B and the newest C-to-B
   invitation.
4. GET with an invitation ID from another goal or workspace is rejected and
   changes no owner, invitation, message, or reminder state.
5. Repeating GET produces identical results and no business side effect.
6. With B still responsible, a pending B-to-C invitation preserves the
   current accepted reference for A-to-B. Accepting the new invitation moves
   the pointer. After C transfers back to B the first reference differs from
   the current one, even though both invitations designated B.

The first test is red before `committedGoalRevision` and the route exist.

## Owner and handoff

- `goals` owner: acceptance commit field, exact query, projection.
- `daemon` owner: authenticated GET route.
- Graph owner: `handoff-query.graph.json`.
- Test owner: public HTTP contract tests in the daemon test surface.
- Architect: reviews source, test and graph evidence; does not implement.

The executor must return changed paths, red/green command output, exact HTTP
responses for the A-B-C-B sequence, and remaining delivery/reminder reconcile
gaps. Formal R20 acceptance still requires an independent real entry path.
