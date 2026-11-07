# delivery-production-dispatch-1107

## Source revision

- Worktree: `/Volumes/Intel/playground/zterm/worktrees/delivery-production-dispatch-20261107`
- Branch: `delivery-production-dispatch-20261107`
- Base: `f99a61a8f39542afcb450a23ad55060dcbcdd697`
- Changes are uncommitted working-tree edits. No commit, push, merge, publish,
  or PR was performed.
- Toolchain: node v22.22.2, pnpm 9.15.9, dagpipe 0.1.1

## Affected DAG

- `android/docs/dagpipe/daemon-app-messaging.graph.json`
- Validated closed SESE: 8 nodes, 7 edges, 8 waves.
- No graph topology edit was needed. This change is inside the V2 delivery
  module and does not alter the daemon app-messaging request chain.

## This revision

- Persisted `v1MessageId` is carried through the accepted-command reader and
  dispatch command. Delivery never synthesizes an ID from `DeliveryRef`.
- First submit refuses to dispatch when the durable receipt has no
  persistence-owned `v1MessageId`.
- `resumeDispatch(actor, ref)` authorizes ref access before reading the accepted
  command, then calls `authorizeResume` with `actor`, persisted `ref`, and the
  persisted target before any content dispatch.
- Dispatch outcomes are typed as `remote-stored`, `unknown`, or `unavailable`.
  The old bare `dispatched` success flag was removed.
- A successful protocol result must carry `observedAt`. Delivery applies
  `remote-stored` evidence through the receipt store and returns the updated
  receipt. If local evidence application fails after a successful protocol send,
  the result stays typed `dispatch-unknown`, not accepted or delivered.
- Missing subject remains durably accepted and returns
  `DISPATCH_UNAVAILABLE` with `SUBJECT_REQUIRED`; an explicitly empty subject is
  `INVALID_INPUT`.
- `resumeDispatch` returns `already-dispatched` only for a durable
  `remote-stored` or higher receipt.

## Receipts

- `pnpm --dir v2/modules/delivery test`: 43/43 pass, output in
  `test-contract.txt`.
- `pnpm --dir v2/modules/delivery test:integration`: 20/20 pass, output in
  `test-integration.txt`.
- Focused strict TypeScript check on the delivery public/application sources:
  exit 0, output in `type-check.txt`.
- `dagpipe graph validate android/docs/dagpipe/daemon-app-messaging.graph.json`:
  exit 0, output in `dagpipe-validate.txt`.
- `git diff --check`: exit 0, output in `diff-check.txt`.
- Integration tests use the real V1 persistence facade and use injected ports
  only where the production public adapters do not yet exist. They are module
  evidence, not proof of a production wire send.

## Open gaps (INCOMPLETE)

- The public V1 persistence facade read-back edge now exposes
  `readAcceptedCommand(ref)` and a persisted UUID `v1MessageId`
  (`app-messaging-readback-public-edge`, integrated in local main 46582eef).
  Closed for the facade scope.
- `connections.requestMessage` / source-gateway resolution (and the
  `app-send-message` wire edge) are now integrated in local main 32584a72
  (`connections-app-send-public-edge-20261107`). Delivery now composes against
  them (see the composition receipt below).
- Real two-machine evidence is still absent. The composition receipt below is a
  real public-consumer wire exercise against a local V1 `/app` gateway, not a
  two-machine proof of source-gateway identity match, identity refusal,
  correlation isolation, or consumed/host-delivered ingress.
- No consumed or host-delivered claim is made. Trusted consumed ingress and file
  chunking remain out of scope.

## Real public consumer composition receipt (rebase onto 32584a72)

After master integrated the three accepted upstream candidates into local main
32584a72, this branch was resumed on that tip (HEAD af9ac54a). The remaining
delivery gap was composition: nothing real drove `resumeDispatch` through the
now-integrated persistence read-back and connections `requestMessage` edges.

- `blackbox-delivery-consumer.mts` imports only the three public entries
  (`createAppMessagingPersistence` from the V1 facade, `createConnectionManager`
  + `AppWebSocketTransport` from connections, `createDeliveryPort` from
  delivery), wires a consumer-owned `MessageDispatchPort` onto `requestMessage`,
  and drives `DeliveryPort.resumeDispatch` against a local V1 `/app` websocket
  gateway.
- Receipt `blackbox-delivery-consumer.log` — 17/17 checks:
  `acceptMessage` persists an immutable command with a UUID `v1MessageId`;
  `resumeDispatch` returns `resumed` with a `remote-stored` receipt; exactly one
  `app-send-message` reaches the gateway, correlated by the persisted
  `v1MessageId`; the non-secret `targetMachineId` never reaches the wire; a
  second `resumeDispatch` returns `already-dispatched` and sends no frame; a
  fresh reopen reads back `remote-stored` and preserves `v1MessageId`.
- Rebase regression receipts: `test-contract-rebase.txt` 43/43,
  `test-integration-rebase.txt` 20/20.
- Two integration tests asserted the pre-readback behavior (accept returns no
  `v1MessageId` -> typed `dispatch-unavailable`). Rebase made accept supply
  `v1MessageId`, so those expectations were updated to the integrated contract
  (first submit dispatches, receipt outcome `confirmed`). The guard itself stays
  covered by the contract test
  `submit refuses to dispatch without the persisted v1MessageId`.

## Scope

Only `v2/modules/delivery/**` and
`v2/evidence/delivery-production-dispatch-1107/**` changed. No V1 source,
private import, WebUI, daemon, or connections edit. No push/merge/publish/PR.
No shared port, tmux server, or 15T action.
