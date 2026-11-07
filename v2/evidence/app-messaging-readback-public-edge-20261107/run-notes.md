# app-messaging-readback-public-edge-20261107

Goal: expose a persistence-owned accepted-command read-back so a delivery consumer can obtain the durable V1 message identity without deriving it from `DeliveryRef`.

Scope: daemon app-messaging persistence facade/store and affected focused tests.

Sequence: record red evidence, implement the smallest public read-back edge, run focused tests and a real public-entry consumer with a temporary durable store, then report delivery evidence.

## Progress

- Red: two focused cases fail on base behavior (missing v1MessageId, missing
  readAcceptedCommand). Captured in red-readback.log.
- Implemented: persist v1MessageId on accept, add readAcceptedCommand edge,
  preserve v1MessageId on evidence update. Store record field is optional for
  backward compatibility.
- Green: focused facade 16/16, focused app-messaging suite 41/41, type-check
  exit 0.
- Black-box: public export `@zterm/android/app-messaging-persistence` against a
  real temp durable store passes 13/13 checks (identity read-back, durability
  across reopen, non-writing reads, evidence-update preservation).
- Remaining gap: none for the public facade scope. Delivery-side adapter wiring
  and wire consumers are out of scope and remain with the delivery worktree.
- Next: commit the scoped changes and evidence on this branch; no push/merge/PR.

## Review pre-delivery fixes

- Jenny's `git diff --check` whitespace findings (trailing whitespace in
  red-readback.log, EOF blank lines in green-readback.log and focused-suite.log)
  are fixed. Log contents are unchanged apart from whitespace; no test was
  rerun because the original receipts remain valid.
- David's evidence-path finding: result.md now lists the absolute evidence
  directory, every referenced log/script, and the exact reproduction commands
  (blackbox read-back, repo-level public package-specifier consumer test,
  focused suites, type-check).
- Added public-consumer-integration.log: the existing committed
  `v2/modules/delivery/tests/integration/app-messaging-persistence-consumer.test.ts`
  passes 4/4 with no edits, proving no regression on the real
  `@zterm/android/app-messaging-persistence` package-specifier consumer.
