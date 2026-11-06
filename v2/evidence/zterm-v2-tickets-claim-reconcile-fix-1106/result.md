# tickets provider-scoped comment claim readback fix

Status: COMPLETE in the local worktree. No commit, push, PR, merge, remote write,
daemon action, or tmux action was performed.

## Root cause

`comment_claims.ref_key` previously stored `operationRefKey(ref)` as SQLite
`TEXT`. SQLite keeps the embedded NUL bytes, but Node `node:sqlite` returns the
text only up to the first NUL. The claim readback therefore returned `ws-1`
instead of `ws-1\0acct-a\0op-a`. `getOperationByExternalComment` then queried
`operations.ref_key` with `ws-1` and returned `undefined`.

## Fix

`v2/modules/tickets/src/adapters/sqlite-binding-store.ts` now stores
`comment_claims.ref_key` as a NUL-free JSON tuple. The read path parses that
tuple back into the canonical `OperationRef` key before querying `operations`.
The conflict path uses the same decoded operation key. The provider-scoped
primary key `(provider_instance_id, external_comment_id)` is unchanged.

## Old-database handling

On open, the adapter reads legacy `operations.ref_key` values through
`hex(ref_key)`. This preserves embedded NUL bytes that Node text reads truncate.
It maps those legacy operation keys to the new claim encoding and rewrites
existing `comment_claims.ref_key` rows in one transaction. The existing
`DROP INDEX IF EXISTS operations_comment_unique` compatibility step remains in
place. The read helper also decodes legacy NUL-separated claim keys if a row is
read before migration.

## Contract evidence

Pre-fix command:

```text
node --test tests/contract/*.test.ts
```

Pre-fix result: 56 pass, 2 fail. Both failures were in
`comment-provider-scope.test.ts` and returned `undefined` instead of the claimed
operation. Raw excerpt: `red-baseline.txt`.

Post-fix focused command:

```text
node --test tests/contract/comment-provider-scope.test.ts
```

Post-fix focused result: 3 pass, 0 fail. Raw output: `green-focused.txt`.

Related claim/recovery/reconcile command:

```text
node --test tests/contract/comment-provider-scope.test.ts \
  tests/contract/operation-ref.test.ts \
  tests/contract/pending-recovery.test.ts \
  tests/contract/restart-new-process.test.ts
```

Related result: 17 pass, 0 fail. Raw output: `green-related.txt`.

Full module command:

```text
node --test tests/contract/*.test.ts
```

Full module result: 58 pass, 0 fail. Raw output: `green-contract.txt`.

## Changed paths

- `v2/modules/tickets/src/adapters/sqlite-binding-store.ts`
- `v2/modules/tickets/tests/contract/comment-provider-scope.test.ts`
- `v2/evidence/zterm-v2-tickets-claim-reconcile-fix-1106/`

## REWORK (public confirmRemoteResult regression)

David review `m1793983039334-772` returned REWORK for one missing
public-consumer regression. The regression is now covered.

New test name:

```text
manual reconciliation exposes the original provider-scoped claim attribution across SQLite readback
```

What it proves. It runs on the public `TicketService` port against both the
in-memory store and the real SQLite store. It first claims comment id 5 for
`op-a` through the real `service.appendReport` path, so the persisted claim uses
the NUL-safe write encoding. It then seeds `op-b` as an unknown appendReport and
hands the same numeric comment id 5 to `service.confirmRemoteResult`. The call is
rejected with the public `BINDING_CONFLICT` error contract, and the thrown
`TicketError.operationRef` carries the original full claim attribution
`{ ws-1, acct-a, op-a }` instead of the truncated `ws-1` or the reconciling
`op-b`. `client.count('createComment')` stays at 1 across the rejection, so the
second attempt makes no new comment network call. The claim owner after the
rejection is still `op-a`. No new port or error field was added; the test uses
the existing public `TicketError.operationRef` field.

Red before the product change. The readback itself is already fixed, but the
conflict error reported the reconciling operation. Command:

```text
node --test tests/contract/comment-provider-scope.test.ts
```

Red result: 3 pass, 1 fail. The failure was a strict deep-equal where the actual
`operationRef.operationId` was `op-b` and the expected was `op-a`. Raw output:
`red-rework.txt`.

Product change required. Yes, one line. In
`v2/modules/tickets/src/application/ticket-service.ts`, the appendReport
reconciliation conflict at the `candidate comment is already claimed by another
operation` throw now passes `already.operationRef` (the original claimant) as the
`TicketError.operationRef` instead of `input.operationRef` (the reconciling
operation). This uses the existing error field only.

Green commands and raw result paths:

```text
node --test tests/contract/comment-provider-scope.test.ts
```

Focused result: 4 pass, 0 fail. Raw output: `green-focused-rework.txt`.

```text
node --test tests/contract/*.test.ts
```

Full module result: 59 pass, 0 fail. Raw output: `green-contract-rework.txt`.
This is the prior baseline of 58 pass plus the one new regression test.

Changed paths in this rework:

- `v2/modules/tickets/tests/contract/comment-provider-scope.test.ts` (new
  public `confirmRemoteResult` regression test)
- `v2/modules/tickets/src/application/ticket-service.ts` (one-line conflict
  attribution fix)
- `v2/evidence/zterm-v2-tickets-claim-reconcile-fix-1106/red-rework.txt`
- `v2/evidence/zterm-v2-tickets-claim-reconcile-fix-1106/green-focused-rework.txt`
- `v2/evidence/zterm-v2-tickets-claim-reconcile-fix-1106/green-contract-rework.txt`
- `v2/evidence/zterm-v2-tickets-claim-reconcile-fix-1106/result.md`

## Known limits

- No real Vikunja network run was needed or performed for this SQLite readback
  boundary. The existing remote-write and provider integration contracts were
  not changed.
- TypeScript compilation was not run because this module has no local
  `tsconfig.json` and no installed `typescript` package. The executable Node
  contract suite passed.
- A legacy claim row that is already truncated and has no recoverable full
  operation key remains unresolved. The current writer never creates that
  state.

## REWORK2 (legacy reopen -> public confirmRemoteResult)

Test name: `legacy claim migration preserves attribution through public confirmRemoteResult conflict`.

Red/green paths. No product change was needed; the existing prior rework one-line conflict attribution fix (`already.operationRef`) already covers this path. The new SQLite-backed legacy reopen plus public reconciliation test passed on its first current-tree run, so there is no honest red. Raw first run saved to `green-rework2-first-run.txt` (5/5 pass). Focused contract run saved to `green-focused-rework2.txt` (5/5 pass). Full module run saved to `green-contract-rework2.txt` (60 pass, 0 fail; prior baseline 59 pass).

Changed paths in this rework.

- `v2/modules/tickets/tests/contract/comment-provider-scope.test.ts` — added one SQLite-backed legacy-database reopen -> public `confirmRemoteResult` conflict test; existing migration test left unchanged.
- `v2/evidence/zterm-v2-tickets-claim-reconcile-fix-1106/green-rework2-first-run.txt` — raw first run of the updated contract suite.
- `v2/evidence/zterm-v2-tickets-claim-reconcile-fix-1106/green-focused-rework2.txt` — raw `node --test tests/contract/comment-provider-scope.test.ts` output.
- `v2/evidence/zterm-v2-tickets-claim-reconcile-fix-1106/green-contract-rework2.txt` — raw `node --test tests/contract/*.test.ts` output.
- `v2/evidence/zterm-v2-tickets-claim-reconcile-fix-1106/result.md` — this section.

Validation commands run from `v2/modules/tickets`:

```
node --test tests/contract/comment-provider-scope.test.ts
node --test tests/contract/*.test.ts
```

Final pass count: 60 pass, 0 fail across the full ticket contract suite.
