# zterm-v2-tickets-impl-1103 R2 recovery-2 notes

Task ID: zterm-v2-tickets-impl-1103 (R2 two-seam recovery, recovery-2)
Branch: zterm-v2-tickets-impl-1103
Baseline head: 12cb233802672989ae01af0d7a0bfcec96dd58bc2961c6d6cc912799330843b8a2
Workspace (recovery-2): 5:/workspaces/31 (earlier mounts 5:/workspaces/29, 5:/workspaces/30 unmounted/discarded)

## Original error preserved

- Original attempt: GCM_EXIT=1, repeated transport error, then
  `apply_patch verification failed: ... /Volumes/extension/code/zterm/v2/modules/tickets/tests/contract/restart-new-process.test.ts: No such file or directory`.
- Cause: host path `/Volumes/extension/code/zterm/v2/...` is not the LayerFS workspace.
- This attempt edits only through the LayerFS CLI with branch-relative `/v2/...` paths.

## Node 0 - inspect baseline

- `layerfs --project zterm workspace mount 5 zterm-v2-tickets-impl-1103` -> `5:/workspaces/29`.
- Read `DESIGN.md`, `sqlite-binding-store.ts`, `in-memory-binding-store.ts`,
  `ticket-service.ts`, `binding-store.ts`, `write-operation.ts`, tests and harness.
- Confirmed seam 1: `operations_comment_unique` is a global UNIQUE on
  `external_comment_id`; `claimComment.otherClaim` also scans by numeric id only.
- Confirmed seam 2: `create/appendReport` persist `pending` before the provider
  write; replay returns `pending`/`await-current-attempt` forever; `confirmRemoteResult`
  only accepts `unknown`.

Command:

```
node --test tests/contract/*.test.ts
```

Baseline result: tests 48, pass 48, fail 0 (duration ~0.6s).

## Node 1 - add red tests

New tests committed in two commits:

- `tests/contract/comment-provider-scope.test.ts`
  - two providers with the same numeric comment id both succeed and stay queryable;
  - one provider cannot hand the same numeric id to a second operation;
  - an existing DB carrying the legacy global index is reopened and the index dropped.
- `tests/contract/pending-recovery.test.ts`
  - live lease is not stolen; expired lease becomes `unknown` without success;
  - succeeded operation is never rewritten;
  - stale pending create replays as `unknown`, no re-POST, then manual confirm works;
  - live-lease confirmation is refused with `OPERATION_CONFLICT`;
  - stale pending appendReport replays as `unknown`, no re-POST.
- `tests/contract/restart-new-process.test.ts` + `tests/support/restart-child.ts`
  - a real child process exits inside `createTask` after the POST is issued,
    leaving a durable pending row; a later child with an expired lease replays
    it as `unknown` with `createCalls=0`.

Red run (workspace 5:/workspaces/31, before implementation):

```
node --test tests/contract/comment-provider-scope.test.ts \
  tests/contract/pending-recovery.test.ts \
  tests/contract/restart-new-process.test.ts
```

Result: tests 11, pass 3, fail 8.

- FAIL two providers share numeric comment id: `BINDING_CONFLICT` "comment is already claimed by another operation".
- FAIL reopen legacy DB: `operations_comment_unique` still present.
- FAIL store.recoverExpiredPending: TypeError (not implemented).
- FAIL stale pending create replay: state stayed `pending`, expected `unknown`.
- FAIL stale pending appendReport replay: state stayed `pending`.
- FAIL durable pending crash: replay stayed `pending`.
- PASS single-provider numeric id rejection (already correct).
- PASS live-lease confirm refusal (already correct without recovery).
- PASS earlier separate-process unknown replay.

Raw red output: `v2/evidence/zterm-v2-tickets-impl-1103/rework2-recovery1/red-pre-impl.txt`.

## Current hypothesis / next step

- Seam 1 fix: drop the global `operations_comment_unique` index on open and
  rely on `comment_claims(provider_instance_id, external_comment_id)`; remove
  the redundant global numeric-id scan in both SQLite and in-memory stores.
- Seam 2 fix: add `BindingStorePort.recoverExpiredPending(ref, now)` to both
  stores. It only transitions `pending -> unknown` when `executionLeaseUntil <= now`;
  it never calls the provider, never marks success, and never rewrites other states.
  Call it on the existing-operation replay read in `create`, `appendReport`,
  and `#mutateState`.
- Then remount at the new head, run the red tests to green, run the full tickets
  contract suite, the real child-process run, and the real Vikunja v2.7.1 blackbox.
+
+## Node 2 - wire spy store port and remount
+
+- Current head after implementation commits: `124320e7093fb49371ad16831cff451d31143c26a1bbf106ce5bf9a4b3cb94f7c5`.
+- Workspace `5:/workspaces/31` is stale because it was mounted before the
+  implementation commits. It will be unmounted and a new workspace mounted
+  from the current head before any green test.
+- `tests/support/harness.ts` `SpyBindingStore` still lacks
+  `recoverExpiredPending`. This is a test-support port seam, not product logic;
+  add the delegation and include it in `STORE_METHODS` so call counts stay
+  observable. Then rerun the focused tests on a fresh workspace.
+- Next: apply this harness change, remount, run focused red files to green.
+
+## Node 3 - green tests and real blackbox (complete)
+
+- Remounted workspace `5:/workspaces/32` at head `1222911562c2aceb239de2e690ee053fde16315e11105a7ed2760f2d8a33dad653`; evidence then committed at head `12595d51e7a27788054cae6de7eca9821acb8d278b356d60d4da54a0ae4f29ee27`.
+- Focused two-seam tests: 11/11 pass (`green-focused.txt`); full tickets contract suite: 58/58 pass (`green-contract.txt`).
+- New-process durable pending/recovery: 2/2 pass (`restart-new-process.txt`); lease valid pending not preempted, expired pending becomes `unknown`, succeeded record never rewritten, no re-POST.
+- Real Vikunja v2.7.1 `/api/v2` blackbox: 2/2 pass at `host.docker.internal:12745` (`integration-real-recovery1.txt`); `/info` HTTP 200 version v2.7.1; project A id 40; tokens only in process environment, not printed/persisted; secret scan found no token/JWT patterns (`secret-scan.txt`).
+- Evidence head: `12595d51e7a27788054cae6de7eca9821acb8d278b356d60d4da54a0ae4f29ee27`; final head after this result-note commit is reported in the handoff receipt. Allowed diff only `v2/modules/tickets/**` and `v2/evidence/zterm-v2-tickets-impl-1103/**`; no push/PR/merge/global install/daemon restart/tmux operation.
