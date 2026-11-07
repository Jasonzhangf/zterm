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

- The public V1 persistence facade does not yet expose
  `readAcceptedCommand(ref)` or a persisted `v1MessageId` adapter. Current V1
  receipts therefore produce typed `dispatch-unavailable` rather than a
  production dispatch.
- `connections.requestMessage` / source gateway / target selector resolution
  and the public runtime entry are not implemented in this scope. The
  connections public-runtime import task remains an upstream dependency.
- Real two-machine evidence is absent for source-gateway identity match, target
  authorization, remote storage, identity refusal, correlation isolation,
  same-ID recovery, and send-authorized resume.
- No consumed, host-delivered, or production remote-stored claim is made.
  Trusted consumed ingress and file chunking remain out of scope.

## Scope

Only `v2/modules/delivery/**` and
`v2/evidence/delivery-production-dispatch-1107/**` changed. No V1 source,
private import, WebUI, daemon, or connections edit. No push/merge/publish/PR.
No shared port, tmux server, or 15T action.
