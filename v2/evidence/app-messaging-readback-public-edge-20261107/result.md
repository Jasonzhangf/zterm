# app-messaging-readback-public-edge-20261107 — result

Task: expose a persistence-owned accepted-command read-back edge on the daemon
app-messaging public facade, so a delivery consumer can obtain the durable V1
message identity from the persisted command instead of deriving it from
DeliveryRef.

Board: parent delivery-production-dispatch-1107, owner Frank, reviewer David.
Base commit: 9a4b2799. Branch: app-messaging-readback-public-edge-20261107.

## Deliverable

- `acceptMessage` now persists an independent `v1MessageId` (randomUUID) on the
  accepted-command record and surfaces it on the created/replayed receipt.
- New public edge `readAcceptedCommand(ref)` returns the persisted
  `AcceptedCommand` (deliveryRef, target, kind, message, v1MessageId) as an
  immutable value, or a typed `not-found` / `invalid-input` / `unavailable`
  result. The read path performs no store write.
- `applyReceiptEvidence` preserves `v1MessageId` when it rewrites the record.
- Store `AppDeliveryRecord` gains an optional `v1MessageId` field for
  backward compatibility with older records.

Scope stayed within android/src/server/daemon-app-messaging-public.ts,
daemon-app-messaging-store.ts and the focused persistence tests. No changes to
delivery/connections, no duplicated wire types, no delivery-receipt domain as
the persistence truth.

## Evidence

All evidence files live in this directory:
`/Volumes/Intel/playground/zterm/worktrees/app-messaging-readback-public-edge-20261107/v2/evidence/app-messaging-readback-public-edge-20261107/`

Red first (missing behavior fails): red-readback.log
- created receipt v1MessageId undefined (.toMatch got undefined)
- store.readAcceptedCommand is not a function

Green (focused facade suite): green-readback.log — 16/16 pass.
Focused app-messaging suite (public + store + runtime + race): focused-suite.log
— 41/41 pass.
Type check: typecheck.log — tsc --noEmit + source-js-pollution clean, exit 0.

Black-box public-entry receipt (real temp durable store, imported through the
package export `@zterm/android/app-messaging-persistence`): blackbox-readback.log
— 13/13 checks pass:
- invalid ref -> invalid-input; missing ref -> not-found
- read-only paths create no app-delivery directory
- acceptMessage -> created with UUID v1MessageId
- readAcceptedCommand -> found, frozen command, exact accepted content + v1MessageId
- fresh reopen -> found, same v1MessageId (durable)
- applyReceiptEvidence -> applied, v1MessageId survives the update

Public package-specifier consumer regression (existing repo test, no edits):
public-consumer-integration.log — node:test 4/4 pass. It imports
`@zterm/android/app-messaging-persistence` through the workspace dependency link,
so it exercises the true public package export across accept/apply/read and
fresh child-process reopen.

## Reproduction

Public consumer script: `blackbox-readback.mts` in this directory. It imports
the public facade source (the exact file that the
`@zterm/android/app-messaging-persistence` export points to) and the production
transition `applyReceiptEvidence`. Run it from the android package:

    cd /Volumes/Intel/playground/zterm/worktrees/app-messaging-readback-public-edge-20261107/android
    pnpm exec tsx ../v2/evidence/app-messaging-readback-public-edge-20261107/blackbox-readback.mts

Public package-specifier consumer regression (already committed in the repo, no
edits):

    cd /Volumes/Intel/playground/zterm/worktrees/app-messaging-readback-public-edge-20261107/v2/modules/delivery
    node --test tests/integration/app-messaging-persistence-consumer.test.ts

Focused suites:

    cd /Volumes/Intel/playground/zterm/worktrees/app-messaging-readback-public-edge-20261107/android
    pnpm exec vitest run src/server/daemon-app-messaging-public.test.ts
    pnpm exec vitest run src/server/daemon-app-messaging-public.test.ts src/server/daemon-app-messaging-store.test.ts src/server/daemon-app-messaging-runtime.test.ts src/server/daemon-app-messaging-race.test.ts

Type check:

    cd /Volumes/Intel/playground/zterm/worktrees/app-messaging-readback-public-edge-20261107/android
    pnpm run type-check

## Review findings addressed

Jenny's `git diff --check` findings on the evidence logs are fixed in this
commit: trailing whitespace removed from red-readback.log, EOF blank lines
removed from green-readback.log and focused-suite.log. `git diff --check`
against HEAD is clean. The log contents are unchanged apart from whitespace;
the red/green/focused receipts stay valid and were not rerun.

## Boundary

Not pushed, merged, PR'd, published. No touch of shared services, tmux 16906, or
15T. Delivery-side adapter wiring (v1-receipt-store.ts) and wire consumers live
in the delivery worktree and are out of this task's scope.
