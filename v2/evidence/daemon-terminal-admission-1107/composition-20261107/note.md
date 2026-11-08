# terminal-admission-composition-1107 task log

## Long-term goal

The V2 daemon must open and feed the exact terminal bound to an authorized
member, with the member-to-native-target mapping persisted by members and
resolved only through public owners. Any missing admission, resolver, binding,
machine link, or terminal target must fail closed with a typed error and no
channel/input side effect.

## 2026-11-07 orientation and architecture mapping

Purpose: align this composition task with the current architecture before edits.

- Board task `terminal-admission-composition-1107`, revision 3.
- Contract: `/Volumes/extension/code/zterm/tmp/v2-webui-audit/terminal-binding-contract-decision-20261107.md`.
- Worktree `/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107`,
  branch `daemon-terminal-admission-20261107`, base `f99a61a8`.
- Business DAG `daemon.connection_channel_catalog` and execution DAG
  `daemon.input_schedule` both validate: 19 nodes/24 edges/10 waves and
  11 nodes/14 edges/5 waves. Admission remains a precondition on
  `extract.arc.channel_input_event`; no graph topology change is needed.

Mapping:

- members owns the persisted optional `terminalTarget {backend, stableId}` in
  the existing binding record and the read-only
  `resolveBindingTarget({binding, catalog})` adapter.
- daemon owns HTTP admission order and typed failure translation.
- routing owns workspace/member authorization. accounts owns the verified
  caller auth context. terminal provides the machine-scoped catalog and input
  consumer for the daemon's V1 link. connections owns the physical link
  generation and daemon host identity; the daemon consumes that link context
  and does not persist a second machine state.
- Gap class: add the missing members binding-target link and wire the existing
  daemon resolver injection to the members-owned public adapter.

Planned gate:

- red: members contract tests for persisted target, rebind generation,
  omission-not-copy, and exact-match resolver;
- green: members suite, daemon admission suite, daemon legacy terminal slice;
- syntax: `node --check` for every changed source/test;
- DAG: both daemon graphs validate once on the current revision.

## 2026-11-07 red/green progress

Purpose: prove the members contract is missing before adding it, then add the
smallest public edge.

Red receipt `red-members.txt`: the new tests fail because
`members/src/public/index.mjs` has no `resolveBindingTarget` export.

Baseline check `members-baseline-before.txt`: the existing members suite also
failed before this change because its trusted owner token had no `org:write`
scope and its fixture omitted `expectedRevision`. Both are test-fixture
plumbing, not product behavior. The fixture now supplies the same seed shape
used by routing tests; no assertion was weakened.

Implementation:

- members `bindSession` accepts optional nullable `terminalTarget`; malformed
  values are rejected before the store mutation, omission stores null and never
  copies the previous target, and every successful rebind advances the existing
  generation.
- members `getRuntimeBinding`, `queryBinding`, and `getBinding` project the
  persisted target as a copy.
- new read-only `resolveBindingTarget({binding, catalog})` returns a target
  copy only on one exact catalog match; no match or ambiguity returns null.
- daemon admission defaults to the members-owned resolver when the members port
  exposes it, and fails closed with
  `TERMINAL_TARGET_BINDING_UNAVAILABLE` when no resolver exists.

## 2026-11-07 focused green and delivery

Purpose: finish the public members-to-daemon admission composition on the
existing worktree and prepare the independent review handoff.

Evidence sources: the task contract, current worktree diff, isolated test tmux
fixtures, and the raw receipts in this directory.

Actual result: the members contract tests pass 22/22; daemon admission tests
pass 20/20; the legacy terminal slice passes 3/3; all eight changed source or
test files pass `node --check`; both affected daemon DAGs validate. The tests
cover successful exact-target input, typed refusal before side effects, stale
binding and link generations, wrong machine, revoked link, missing resolver,
missing machine consumer, stream exact-session projection, and byte-preserving
input.

Progress from the red receipt: the missing members resolver and daemon
machine-scoped target composition are now implemented and green. The original
red failures were `resolveBindingTarget` not exported and five daemon admission
cases returning 424 instead of the expected 404 or 200.

Remaining gap: David must independently review the implementation and receipts.
Merge, integration, and close remain blocked by that review and the project Git
freeze. No shared service, worktree, tmux, or global runtime was changed.

Next step: deliver `result.md` and the raw receipts to David, then answer any
review finding without broadening scope.

## 2026-11-07 19:43 UTC - recovery composition and catalog-edge blocker

Purpose: resume after Jenny confirmed `connections-public-runtime-1107` is
accepted with review PASS, then combine the accepted shared and connections
code in this task worktree and test the real public runtime edge.

Composition evidence:

- Applied `shared-runtime-resolvability-20261107` commit `286a6f32` directly
  into this worktree. It changes 10 `packages/shared` files.
- Applied the dirty `v2/modules/connections` diff from
  `connections-cross-device-foundation-20261106`. It changes 14 files.
- Applied the dirty `android/src/server` diff from
  `mux-ready-daemon-host-id-20261107`. It changes 4 files.
- No upstream worktree was reset, restored, renamed, merged, pushed, or cleaned.

Results:

- `public-runtime-probe.txt`: `createConnectionManager=function`, exit 0.
- `connections-typecheck.txt`: TypeScript exit 0 with no diagnostics.
- `connections-tests.txt`: 41 passed, 2 skipped, 0 failed, exit 0.
- `composed-module-tests.txt`: daemon + members composition suites 53 passed,
  0 failed, exit 0.
- `catalog-edge-probe.txt`: the real connections public manager has
  `listSessions=undefined`. The daemon machine-terminal consumer fails with
  typed `TERMINAL_ADMISSION_UNAVAILABLE` and cause
  `{ reason: "connections-catalog-missing" }` before any channel open or input.

Progress: shared/connections public imports now execute together, and the
accepted dependencies no longer fail at module resolution or type-check.

Refined catalog gap: V1 serves `list-sessions` only as a
`mux-target-message`, but `V1TraversalTransport` does not send or correlate
that target request. The public connections manager cannot expose
`listSessions(link)` until that control edge exists, so the daemon consumer
stays fail-closed with `TERMINAL_ADMISSION_UNAVAILABLE` and zero channel side
effects.

Remaining gap: the accepted connections public runtime does not expose a
`listSessions(link)` catalog edge. The real accounts/connections/terminal
admission path cannot resolve its machine catalog, so stream/input success and
wrong-identity/revoked/rebind real-entry cases cannot be completed. This is an
out-of-scope connections owner change under the current contract.

Next: report the exact blocker and evidence to Jenny. Keep the task
`working/INCOMPLETE`; do not deliver as complete, do not edit connections, and
do not change shared services, tmux, or Git integration.

## 2026-11-07 20:03 UTC - catalog-edge ownership adjudication

Purpose: record Jenny's ownership decision in `m1794081806687-6918` and update
the task's recovery condition without changing the tested product source.

Decision: `terminal-admission-composition-1107` must not modify
`v2/modules/connections` and must not add a daemon shim. The missing
`listSessions(link)` edge is now a separate task,
`connections-catalog-edge-20261107`, assigned to the connections owner, Kate.

Result: the task remains `working/INCOMPLETE`. The previous fail-closed probe
and composition receipts remain valid. No new public-entry verification can
prove business success until Kate's catalog edge is available.

Next: when `connections-catalog-edge-20261107` is accepted, rerun the real
public entry path from accounts through connections to terminal admission,
covering successful binding and target resolution, wrong identity, revoked
link, rebind, and raw input; then hand the evidence to David for review. Do not
merge, push, publish, open a PR, restart shared services, or touch tmux or the
15T device.

## 2026-11-07 20:07 UTC - board owner mismatch

Purpose: verify that the separate catalog task has a real owner before the
composition waits on it.

Observed on the board at `2026-11-07T20:07:00.674Z`:

- `connections-catalog-edge-20261107`: `status=working`,
  `owner_display_name=Jenny`, `owner_name=null`, `owner_session_id=null`,
  `invited_peer=null`, and the next step still says to publish or invite the
  connections owner Kate.
- `collab task status connections-catalog-edge-20261107`: owner is Jenny's
  master worker and `completion_missing=[review]`.
- Kate's `task_ids` do not contain `connections-catalog-edge-20261107`.

Action: sent Jenny `m1794082039981-6950` with the exact board evidence and
requested a real invite/accept assignment to Kate or an explicit replacement
owner and recovery signal. The composition task remains `working`; no source
or runtime action was taken.

Next: re-read the catalog task owner after Jenny's response. When the catalog
edge is accepted by its actual connections owner, continue the public-entry
verification sequence above.

## 2026-11-07 20:08 UTC - catalog invitation confirmed, acceptance pending

Purpose: verify Jenny's dispatch correction after `m1794082096139-6958`.

Observed: `connections-catalog-edge-20261107` now has
`invited_peer=collab-0ac582a21c02e391d999af716ab771cf` (Kate), but remains
`status=working`, `owner_display_name=Jenny`, revision 3. An invitation is not
an accepted assignment or a delivered catalog edge.

Result: the composition recovery signal is now concrete: Kate accepts the
catalog task, implements the public edge, and it is accepted. Until then,
`terminal-admission-composition-1107` remains `working/INCOMPLETE`; its
existing fail-closed probe remains valid red evidence.

Next: check the catalog task's owner and status when a completion notification
arrives. Do not treat the invitation alone as readiness for public-entry
success testing.

## 2026-11-07 20:12 UTC - catalog ownership accepted by Kate

Purpose: verify the recovery signal after Jenny's invitation dispatch.

Observed on the board at `2026-11-07T20:09:29.368Z`:

- `connections-catalog-edge-20261107`: `status=working`,
  `owner=collab-0ac582a21c02e391d999af716ab771cf` (Kate),
  `executor_name=Kate`, `delivery_complete=false`,
  `completion_missing=[review]`.

Result: the dependency now has a real owner. This is ownership acceptance
only, not a delivered or accepted catalog edge.
`terminal-admission-composition-1107` remains `working/INCOMPLETE`, and the
existing fail-closed probe stays valid.

Next: wait for Kate's durable delivery notification. Only after
`connections-catalog-edge-20261107` is accepted, rerun the real public-entry
sequence (binding and target resolution, wrong identity, revoked link, rebind,
and raw input) and hand the evidence to David.

## 2026-11-07 20:22 UTC - local fixture protocol preparation finding

Purpose: prepare the real public-entry composition matrix before Kate's
catalog edge lands, without touching product source or shared services.

Evidence: `fixture-protocol-probe.mjs` and `fixture-protocol-probe.txt`. The
real `createConnectionManager` public entry, using `V1TraversalTransport`,
rejects the local V1 mux fixture's first response with:

```json
{
  "connect": {
    "ok": false,
    "error": {
      "code": "unknown",
      "message": "unexpected mux frame"
    }
  }
}
```

Source comparison:

- `packages/shared/src/connection/protocol.ts`
  `isTerminalMuxServerFrame` accepts `mux-ready` only when
  `capabilities.version === 1`, `capabilities.channelEnvelope === true`, and
  `capabilities.targetMessages === true`.
- `v2/modules/terminal/tests/v1-mux-fixture.mjs` sends only
  `capabilities: { reliableInput: { version: 1 } }`.
- The same fixture omits canonical `daemonHostId`, while the accepted real
  daemon patch advertises it through `buildTerminalMuxReady`.

Impact: after Kate's catalog edge is accepted, a fixture-based composition
success run still cannot pass. The current daemon tests pass because their
injected machine terminal consumer bypasses the connections handshake and
uses constant identity fields.

Result: `terminal-admission-composition-1107` remains `working/INCOMPLETE`.
This is preparation evidence only; no product source was changed.

Next: ask Jenny to assign the test-only fixture alignment to the right owner.
The minimal fix is to build the fixture `mux-ready` through the shared
protocol helpers (`buildTerminalMuxReady` / `buildTerminalMuxCapabilities`)
and add an optional `daemonHostId` fixture parameter so existing callers stay
unchanged. Until the fixture speaks the accepted contract, the composition
matrix cannot produce local success evidence.

## 2026-11-07 20:38 UTC - fixture contract alignment, abc9cd28 composition

Purpose: execute Jenny's authorized fixture fix (`m1794083362251-7089`,
`m1794083466670-7099`) and incorporate the latest accepted shared config
(`m1794083682310-7137`).

Fixture fix, scope test-only:

- `v2/modules/terminal/tests/v1-mux-fixture.mjs` now builds the `mux-ready`
  frame through `buildTerminalMuxReady` / `buildTerminalMuxCapabilities` from
  `packages/shared/src/connection/protocol.ts`, preserving the existing
  `reliableInput` capability and adding the optional `daemonHostId` fixture
  parameter with default behavior unchanged.

Evidence:

- `fixture-ready-frame-probe.mjs` / `.txt`: raw mux-ready frame carries
  `daemonHostId: "daemon-composition-ready-frame"` and the accepted
  capabilities, exit 0.
- `fixture-protocol-probe.mjs` / `.txt`: real `createConnectionManager` +
  `V1TraversalTransport` connects to the aligned fixture, reports
  `peerIdentityVerified=true` and `peerIdentity=daemon-composition-protocol`,
  all checks true, exit 0.
- `fixture-consumers-pass.txt`: daemon admission + terminal slice + terminal
  port suites, 27 passed, 0 failed, exit 0.

Shared composition:

- Applied `abc9cd28` (`packages/shared/tsconfig.build.json`,
  `packages/shared/tsconfig.json`) on top of the already composed
  `286a6f32`, using the same `git show | git apply` method documented in
  `composition-method.txt`. No reset, restore, merge, or other worktree
  mutation.

Baseline note:

- `repair-closure.test.mjs` and `terminal-late-close.test.mjs` fail with
  `TARGET_NOT_FOUND` before and after the fixture change (verified by
  reverting the fixture patch and rerunning). These are pre-existing local
  failures in the composition worktree and are not introduced by this change.

Result: `terminal-admission-composition-1107` remains `working/INCOMPLETE`.
The fixture now speaks the accepted wire contract, so the local
public-entry matrix can run once the catalog edge exists.

Next: check Kate's catalog delivery and acceptance. After the catalog edge is
accepted, compose it and rerun the public-entry matrix (binding, target
resolution, wrong identity, revoke/rebind, stream, raw input), then hand
evidence to David and reply to `m1794083466670-7099` / `m1794083682310-7137`
through their completion obligations.

## 2026-11-07 20:43 UTC - Jenny correction accepted

Purpose: align with Jenny's correction `m1794084164076-7206`.

Jenny reran `fixture-protocol-probe.mjs` on the restored tree and confirmed
`connect.ok=true`, connected/fresh, `peerIdentity=daemon-composition-protocol`,
`peerIdentityVerified=true`, all checks true, exit 0. No further fixture or
probe change is needed.

Result: this item is closed by the owner. `terminal-admission-composition-1107`
remains `working/INCOMPLETE`, waiting on David review/accept of
`connections-catalog-edge-20261107` (currently `delivered`).

## 2026-11-07 22:20 UTC - dev-auth fixture public-entry matrix and subscribe contract repair

Purpose: resume the dependency-cleared composition and run the public entry
matrix required by Jenny.

Observed sequence:

- The composed worktree now includes the accepted connections catalog edge and
  shared runtime prerequisites.
- `public-entry-matrix.mjs` uses dev-auth, an isolated tmux-backed simulated
  V1 mux fixture, the real connections manager and V1 transport, the real
  daemon machine-terminal consumer, real members/organization/routing services,
  and the real daemon HTTP routes.
- The first run reached the stream route and failed with HTTP 400:
  `machine-terminal.subscribe` rejected the server's
  `{ onFrame, onError }` listener because the consumer accepted only a
  function.

Root cause and repair:

- `machine-terminal-consumer.mjs` now normalizes function and object listeners,
  parses the connections channel envelope, and feeds `buffer-sync` payloads
  through the shared `@zterm/stream-boundary` render runtime.
- Only committed snapshots are emitted as frames. The subscription returns
  `{ close }`, matching the daemon server lifecycle and TerminalPort.
- `terminal-port.mjs` exports its existing `toFrameChunk` and
  `snapshotToFrame` helpers so the daemon adapter reuses the terminal owner's
  projection instead of maintaining a second parser.
- The fixture now handles `mux-channel-binary`, which is the real
  `V1TraversalTransport` encoding for raw input.

Evidence:

- `public-entry-matrix-red.txt`: original `stale_generation` red receipt.
- `public-entry-matrix.txt`: final matrix, 10/10 cases passed.
- `consumer-subscribe-tests.txt`: focused consumer/admission tests, 31/31
  passed, including object listener and multi-chunk assembly.
- `consumer-reuse-tests.txt`: earlier one-link-per-machine regression receipt.
- `public-entry-matrix.mjs`: reproducible dev-auth fixture public-entry
  scenario.
- `terminal-port-followup.txt`: terminal-port and mux-client regression,
  8/8 passed.

Result: `terminal-admission-composition-1107` remains `working/INCOMPLETE`.
The matrix covers green admission, HTTP input, wrong machine, unbound and
unknown targets, stale binding generation, wrong daemon identity, and a
physically disconnected link. It preserves no unexpected channel or input side
effects. Its raw-input receipt records the fixture-received string and a marker
in tmux output; it does not prove a committed stream body frame, and its CR
marker can also match input echo. It is not real accounts or a real V1 daemon.
No merge, push, publish, shared-service restart, tmux/global service action, or
device action was performed.

Next: send the evidence path and task revision to David for independent review,
then reply to Jenny's completion message.

Jenny later confirmed that she integrated and closed
`delivery-app-transition-tables-1107` as `07d07c77` on local main. No duplicate
integration worktree or cherry-pick was created.

## 2026-11-07 22:31 UTC - David readiness correction and next real scope

Purpose: apply David's readiness review `m1794090533154-7899` and Jenny's
follow-up `m1794090663456-7924` without changing the green test behavior.

Observed sequence:

- David reviewed the matrix at
  `/Volumes/extension/code/zterm/tmp/v2-webui-audit/daemon-terminal-admission-review-20261107.md`.
- The harness still uses `createRoutingDevAuth` and an inline
  `authorizeMachine` that returns constants. This is not real accounts.
- `main.mjs` calls `startDaemon` without production
  admission/accounts/connections assembly. Binding is a harness `bindTarget`,
  not a product host-binding producer.
- The stream check only waits for `event: ready`, not a committed body frame.
- The red revoked-link case closes the fixture socket. It proves physical
  disconnect refusal, not accounts revocation while the transport stays
  connected.

Result: relabeled the matrix harness and evidence, preserving the green
receipts. The task remains `working/INCOMPLETE`.

Next: the corrected real product composition scope is in
`real-composition-next-scope.md`. It requests startup/config, login/grant to
member binding, real committed body frames, real input execution output, and
real revocation rejection using the already accepted public modules. Jenny must
route the production composition; David re-reviews after real-composition
evidence arrives.

## 2026-11-08 00:55 UTC - post-rebase recovery verification

Purpose: confirm the rebased candidate after local main moved to `32584a72`
and capture the isolated V1 fixture that previously failed at import time.

Root cause and repair:

- The first isolated fixture run failed with `ERR_MODULE_NOT_FOUND` for
  `@zterm/shared/dist/terminal/tmux-socket-path.js`.
- `packages/shared` had no built `dist/` in this worktree.
- `pnpm --filter @zterm/shared build` succeeded and produced the missing
  runtime path.

Real isolated V1 fixture:

- Command:
  `ZTERM_CANDIDATE_ROOT=/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107 node run.mjs run`
- Workdir:
  `/Volumes/Intel/playground/zterm/.worker-runs/isolated-v1-stream-fixture-1105`
- Run: `isolated-v1-40211-mw742min`, host `127.0.0.1`, port `49762`,
  `realV1Daemon=true`.
- Gates: `initialFrame`, `inputEcho`, `secondTargetIsolation`, and
  `recoverableInterruption` are all true.
- Receipt: `isolated-v1-40211-mw742min-run-summary.json`.

Regression and boundary:

- Changed-module suite: 88/88 PASS (terminal 34, daemon 51, errors 2,
  status 1).
- Syntax checks on changed source and test files: `SYNTAX_OK`.
- Public imports: terminal, errors, and status all import successfully with
  their declared exports.
- DAG validation: both daemon graphs exit 0.
- Evidence file: `post-rebase-verification-20261107.txt`.

Result: the rebase no longer blocks the disposable V1 fixture, but the
fixture is not production composition. `terminal-admission-composition-1107`
remains `working/INCOMPLETE`. Production startup/config assembly, a real
members/host binding producer, real accounts login/grant/revocation evidence,
and real committed frame/input execution remain pending. No merge, push,
publish, PR, shared daemon restart, tmux/global service action, or device
action was performed.

## 2026-11-08 01:44 UTC - current main base correction and integration finding

Purpose: apply Jenny's correction `m1794101422131-8937`, which says local main
is now `b9b479f6` and the composition candidate must be composed or rebased
onto it before delivery or integration.

Baseline facts:

- Worktree: `/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107`.
- Branch: `daemon-terminal-admission-20261107`.
- `git status --short --branch` is clean except for the branch header.
- `git merge-base --is-ancestor b9b479f65a7ac9ef71177068d43fcee468b50145 HEAD`
  exits 0.
- `git rev-list --count b9b479f65a7ac9ef71177068d43fcee468b50145..HEAD`
  returns 3.
- The local candidate commits are `c92dab11`, `878bde70`, and `aebe82d2`.

Result: the candidate is already composed on top of current local main
`b9b479f6`. No rebase or merge operation was needed, and no dirty user change
was reset or discarded.

Focused integration test:

```text
node --test \
  v2/modules/members/tests/members.test.mjs \
  v2/modules/daemon/tests/terminal-admission.test.mjs \
  v2/modules/daemon/tests/terminal-slice.test.mjs \
  v2/modules/daemon/tests/terminal-input-raw.test.mjs
```

Observed result: 45 passed, 5 failed. All five failures are in
`v2/modules/daemon/tests/terminal-input-raw.test.mjs`. The same test file
passes 5/5 on local main `b9b479f6`.

Root cause: `b9b479f6` added `terminal-input-raw.test.mjs`, which starts
`createDaemon` with only a terminal port and V2 token. The composition branch
requires `context.admission` for `/api/terminal/input`, so the route returns
503 `TERMINAL_ADMISSION_REQUIRED`. The inherited test also asserts the legacy
token-only auto-Enter contract. The composition admission tests instead require
admission and exact byte forwarding, with a separate explicit CR case.

This is an integration contract conflict, not a missing current-main
composition step. The branch cannot be called green until the inherited test
is updated or retired by its owner. Do not restore the legacy token-only input
path; that would violate the composition contract.

Jenny received the evidence and decision request as `m1794102792261-9084`.
The board task was updated to revision 25 with the same facts.

No push, PR, publish, merge to main, shared daemon restart, tmux/global service
action, or device action was performed.
