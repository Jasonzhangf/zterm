# terminal-admission-composition-1107 delivery

## Task and boundary

- Task: `terminal-admission-composition-1107`
- Executor: Emma
- Reviewer: David
- Status at delivery: `working/INCOMPLETE`
- Worktree: `/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107`
- Branch: `daemon-terminal-admission-20261107`
- Base: `f99a61a8`
- Scope kept to `v2/modules/members`, `v2/modules/daemon`, the task evidence
  directory, and test-only fixture/frame exports in `v2/modules/terminal`.
  Accepted dependency source is composed separately in the same worktree.
- No push, merge, publish, PR, shared daemon restart, tmux/global service action, or change to `8899`, `3333`, `8801`, tmux server `16906`, or `15T`.

## Implemented behavior

The members public binding contract now persists an optional nullable
`terminalTarget` of `{ backend, stableId }`. A successful bind or rebind
advances the existing binding generation, and an omitted target stores `null`
instead of copying the previous target. Binding readers return target copies,
so caller mutation cannot reach the members store.

`resolveBindingTarget({ binding, catalog })` is exported from the members public
entry. It is read-only, opens no transport, and returns a copied target only
when exactly one catalog entry matches `backend` and `stableId`. Missing,
malformed, absent, or ambiguous matches return `null`.

The daemon creates admission only when all required public ports are supplied.
The stream and input routes pass the caller credential into admission. The
daemon asks routing for the member address, reads the current binding from
members, verifies the current generation, gets a connections-authorized
machine-scoped terminal consumer, resolves the exact target through the
members-owned adapter, and only then subscribes or writes input.

Admission rechecks the current binding generation, machine link generation,
and verified daemon host identity before dispatch. A stale or mismatched
binding, missing resolver, missing machine terminal consumer, revoked link,
wrong machine, or unrelated target fails closed before any terminal open or
input side effect. Valid input is forwarded byte-for-byte; Enter is not added.

## Changed paths

- `v2/modules/daemon/src/main.mjs`
- `v2/modules/daemon/src/server.mjs`
- `v2/modules/daemon/src/machine-terminal-consumer.mjs`
- `v2/modules/daemon/src/terminal-admission.mjs`
- `v2/modules/daemon/tests/machine-terminal-consumer.test.mjs`
- `v2/modules/daemon/tests/terminal-admission.test.mjs`
- `v2/modules/daemon/tests/terminal-admission-fail-closed.test.mjs`
- `v2/modules/members/DESIGN.md`
- `v2/modules/members/src/application/members-service.mjs`
- `v2/modules/members/src/adapters/terminal-target-resolver.mjs`
- `v2/modules/members/src/public/index.mjs`
- `v2/modules/members/tests/members.test.mjs`
- `v2/modules/terminal/src/terminal-port.mjs`
- `v2/modules/terminal/tests/v1-mux-fixture.mjs`
- `v2/evidence/daemon-terminal-admission-1107/**`

## Focused verification

All commands ran in the task worktree.

- `node --test v2/modules/members/tests/members.test.mjs`: 22 passed, 0 failed, exit 0.
- `node --test v2/modules/daemon/tests/terminal-admission.test.mjs`: 20 passed, 0 failed, exit 0.
- `node --test v2/modules/daemon/tests/terminal-slice.test.mjs`: 3 passed, 0 failed, exit 0.
- `node --check` on the eight changed source or test files: PASS, exit 0.
- `dagpipe graph validate android/docs/dagpipe/daemon-connection-channel-catalog.graph.json`: valid, 19 nodes, 24 edges, 10 waves, exit 0.
- `dagpipe graph validate android/docs/dagpipe/daemon-input-schedule.graph.json`: valid, 11 nodes, 14 edges, 5 waves, exit 0.

Raw receipts:

- `members-test.txt`
- `terminal-admission-test.txt`
- `terminal-slice-test.txt`
- `syntax-checks.txt`
- `dagpipe.txt`
- `red-members.txt`
- `red-daemon-machine-scope.txt`
- `public-runtime-probe.txt`
- `catalog-edge-probe.txt`
- `connections-typecheck.txt`
- `connections-tests.txt`
- `composed-module-tests.txt`
- `changed-paths.txt`
- `public-entry-matrix.txt`
- `public-entry-matrix-red.txt`
- `consumer-subscribe-tests.txt`
- `consumer-reuse-tests.txt`

The daemon tests use an isolated V1 mux fixture backed by a test tmux socket.
They assert the HTTP routes, exact admitted target, typed failures, no
channel/input side effects on refusal, current generation rechecks, machine
link generation and daemon host identity checks, and raw input fidelity.

## 2026-11-07 recovery composition

Jenny's recovery message `m1794080003821-6636` confirmed that
`connections-public-runtime-1107` is accepted with review PASS. The current
worktree now composes these accepted dependency sources without resetting or
modifying their source worktrees:

- `shared-runtime-resolvability-20261107` commit `286a6f32`
  (`packages/shared`, 10 files).
- Dirty `v2/modules/connections` diff from
  `connections-cross-device-foundation-20261106` (14 files).
- Dirty `android/src/server` diff from
  `mux-ready-daemon-host-id-20261107` (4 files).

The combined public runtime probe exits 0 and prints:

```text
createConnectionManager=function
```

Connections type-check exits 0. Its tests pass 41, with 2 tests in the
unavailable real-daemon suite skipped, and 0 failures. The combined daemon and
members suites pass 53 with 0 failures.

## Catalog edge (historical blocker, now resolved)

The accepted connections public runtime still has no `listSessions(link)`
method at that point in time. `catalog-edge-probe.mjs` uses the real
`createConnectionManager` public entry, then enters the daemon machine-terminal
consumer. It returns:

```json
{
  "connectionManager": {
    "create": "function",
    "listSessions": "undefined"
  },
  "outcome": "typed-failure",
  "error": {
    "code": "TERMINAL_ADMISSION_UNAVAILABLE",
    "cause": {
      "reason": "connections-catalog-missing"
    }
  },
  "channelOpensAfterCatalogFailure": 0,
  "channelSendsAfterCatalogFailure": 0
}
```

This blocks the required real accounts/connections/terminal admission path:
the daemon cannot obtain the current machine session catalog, so it cannot
resolve the exact member target or prove successful stream/input behavior. The
fail-closed behavior is verified, but it is not business completion. Adding the
catalog method changes the connections owner's public contract, so this task
must stop that step and report the blocker rather than patch another owner's
source.

This blocker was resolved by the accepted `connections-catalog-edge-20261107`
delivery on local main (`2f82ddf4`). The dev-auth fixture matrix now runs
successfully against the composed connections catalog edge, documented below.

## Remaining work

Independent review by David then integration and closure remain pending. No
claim of merged or published production behavior is made.

## 2026-11-07 final public-entry matrix

The dependency-cleared worktree includes the accepted connections catalog edge
and shared runtime prerequisites. `public-entry-matrix.mjs` uses dev-auth, an
isolated tmux-backed simulated V1 mux fixture, the real connections manager and
V1 traversal transport, the real daemon machine-terminal consumer, real
members/organization/routing services, and the real daemon HTTP routes. It is
not real accounts and not the real V1 daemon.

The first run exposed a concrete subscribe contract mismatch:
`machine-terminal.subscribe` accepted only a function, while the daemon stream
route passes `{ onFrame, onError }`. The daemon adapter now accepts both forms,
parses connections channel messages, feeds buffer frames through the shared
`@zterm/stream-boundary` runtime, emits only committed snapshots, and returns
the server-compatible `{ close }` subscription. `terminal-port.mjs` now exports
its existing frame helpers so the daemon adapter reuses the terminal owner's
projection rather than adding a second parser.

Receipts:

- `public-entry-matrix.txt`: 10/10 cases passed, exit 0.
- `consumer-subscribe-tests.txt`: focused consumer/admission tests passed.
- `public-entry-matrix-red.txt`: original `stale_generation` red evidence.

The matrix covers successful admission on this simulated fixture, HTTP input,
wrong machine, unbound and unknown targets, stale binding generation, wrong
daemon identity, and a physically disconnected link. It preserves no unexpected
channel or input side effects on refusal. Its raw-input receipt records the
string the fixture received and a marker in tmux output; it does not prove a
committed stream body frame and its CR marker can also match input echo.
`red-revoked-link` closes the fixture socket, so it proves physical-disconnect
refusal, not accounts authorization revocation while the transport stays
connected.

Product gaps still remain. `main.mjs` starts `createDaemon` without production
admission/accounts/connections assembly, and binding is a harness `bindTarget`
call rather than a product host-binding producer. Real startup/config,
login/grant authorization, real committed frame delivery, executed input
output, and real revocation remain pending. No merge, push, publish,
shared-service restart, tmux/global service action, or device action was
performed.

## 2026-11-08 post-rebase recovery verification

The rebased candidate includes local main `32584a72`. The previous isolated V1
fixture failure was caused by `packages/shared` having no built `dist/`; the
fixture failed before product behavior with
`ERR_MODULE_NOT_FOUND` for `@zterm/shared/dist/terminal/tmux-socket-path.js`.
The focused repair was `pnpm --filter @zterm/shared build`.

The real isolated V1 fixture now passes:

- Run `isolated-v1-40211-mw742min` used host `127.0.0.1`, port `49762`, and a
  real V1 daemon.
- Gates passed: `initialFrame`, `inputEcho`, `secondTargetIsolation`, and
  `recoverableInterruption`.
- Receipt: `isolated-v1-40211-mw742min-run-summary.json`.

The changed modules also pass 88/88 (terminal 34, daemon 51, errors 2, status
1). Changed-file syntax checks pass. The terminal, errors, and status public
imports expose their declared APIs. Both affected daemon DAGs validate.

This is fixture-backed recovery evidence, not product composition acceptance.
The same production gaps remain: startup/config assembly, a real
members/host binding producer, real accounts login/grant/revocation evidence,
real committed body-frame delivery, and real input execution output. The task
stays `working/INCOMPLETE`; no merge, push, publish, PR, shared daemon
restart, tmux/global service action, or device action was performed.

## 2026-11-08 current-main correction and integration finding

Jenny's correction `m1794101422131-8937` moved the required local main base to
`b9b479f6`. Git ancestry verification shows that this worktree is already
composed on that base:

- `git merge-base --is-ancestor b9b479f6 HEAD` exits 0.
- `git rev-list --count b9b479f6..HEAD` returns 3.
- The local candidate commits are `c92dab11`, `878bde70`, and `aebe82d2`.
- The worktree is clean.

No rebase or merge was required. A focused run of the members, admission,
terminal-slice, and inherited raw-input tests produced 45 passes and 5
failures. All failures are in `terminal-input-raw.test.mjs`; that file passes
on main `b9b479f6`.

The failure is a contract conflict. The inherited test starts `createDaemon`
without admission and expects the legacy token-only input route. This branch
returns `503 TERMINAL_ADMISSION_REQUIRED` for that setup and requires exact
byte forwarding through an admitted route. Restoring the legacy path would
violate the composition contract. The inherited test needs an owner decision
to update it to the admission contract or retire it as superseded.

Jenny received the evidence and decision request as `m1794102792261-9084`.
The board task was updated to revision 25 with the same facts.

The task remains `working/INCOMPLETE`. No push, PR, publish, merge to main,
shared daemon restart, tmux/global service action, or device action was
performed.

## 2026-11-08 decision and 2bc9bab5 rebase verification

Jenny's decision `m1794102837521-9090` directed the inherited raw-input test to
be updated to the admission contract without retiring it and without restoring
the legacy token-only route. The test now exercises a real `createDaemon`
admission configuration with a fake machine-scoped terminal consumer.
Coverage remains for exact bytes, explicit CR, invalid data rejection, delivery
order, authentication failure, and exact target rejection.

Before rebase:

- Rewritten raw-input test: 5/5 PASS.
- Four-file composition suite: 50/50 PASS.
- Test syntax check: exit 0.

The candidate was then rebased onto current local main `2bc9bab5`; the rebase
completed with no conflict. The rebased code/test commit is `13d9e0a4`, and
the branch is 4 local commits ahead of `2bc9bab5`.

After rebase:

- Four-file composition suite: 50/50 PASS.
- Test syntax check: exit 0.
- Raw evidence:
  `v2/evidence/daemon-terminal-admission-1107/composition-20261107/current-main-2bc9bab5-decision-verification-20261108.txt`.

The task remains `working/INCOMPLETE` pending David review, integration, and the
existing production-composition gaps. No push, PR, publish, merge to main,
shared daemon restart, tmux/global service action, or device action was
performed.

## 2026-11-08 producer b467a82a composition re-merge

Jenny's message `m1794119149921-226` reported that the producer dependency for
`terminal-admission-composition-1107` is available. Verified the producer
branch `host-adapter-terminal-target-producer-20261107` at `b467a82a`; its fix
commit `de0cbd16` makes `createTmuxHostProbe.probe()` emit the V1 authoritative
`tmux:v1:<encoded JSON>` stableId (backend, optional real socketPath, serverPid,
sessionId, createdAt) instead of the raw session id.

Re-merged the producer into this composition worktree with no conflicts:

- Old HEAD `7769e0cc`; merge commit `56fb7cb2`.
- No source test or harness edits were committed for this merge.

Verification at HEAD `56fb7cb2`:

- 8-file composition suite: 76/76 PASS. Test 76 is the real integration case
  "host-adapters public probe is the real producer consumed by members bind and
  verify".
  Receipt: `composition-suite-producer-b467a82a.txt`.
- Public-entry matrix (committed 10-case harness): 10/10 PASS.
  Receipt: `public-entry-matrix-producer-b467a82a.txt`.
- Focused producer evidence: committed V1 mux frame stream 1/1 PASS; admission
  raw input and single-CR tests 2/2 PASS.
  Receipts: `producer-b467a82a-20261108/committed-frame.txt`,
  `producer-b467a82a-20261108/raw-input.txt`, with matching `.exit` files.
- `node --check` passes on changed files.
- Four affected DAGs validate: `workspace-control-plane`,
  `workspace-member-resolve`, `daemon-connection-channel-catalog`,
  `daemon-input-schedule`.

Note on evidence hygiene: an earlier `-producer-b467a82a` matrix receipt was
produced by a temporary, since-reverted modification of the matrix harness that
added two cases without updating cumulative side-effect expectations. It was
invalid and has been regenerated from the committed 10-case harness. The
committed `public-entry-matrix.mjs` is unchanged.

Remaining production-composition gaps: startup/config assembly, real accounts
login/grant/revocation evidence, and real input execution output. The task
stays `working/INCOMPLETE` pending David review and integration. No push, PR,
publish, merge to main, shared daemon restart, tmux/global service action, or
device action was performed.

## 2026-11-08 connections public-directory entry composition

Jenny's message `m1794129333247-1199` reported that the connections owner
candidate `connections-authority-runtime-entry-1107` at `317a8d3c` passed
independent read-only review with `findings=[]`. It adds the public entry
`resolveAuthorizedTerminalDirectory` in `v2/modules/connections/src/public/index.mjs`.

Merged the connections candidate into this composition worktree with no
conflict: merge commit `a86214c4` on branch `daemon-terminal-admission-20261107`.

Composition change (single owner: `v2/modules/daemon/src/machine-terminal-consumer.mjs`):

- The daemon machine-terminal adapter no longer re-implements the
  connections directory. It now calls the connections-owned public entry
  `resolveAuthorizedTerminalDirectory({ connectionManager, machineId })`, so the
  machine-scoped catalog and every terminal channel open come from one current
  authorized `LinkRef`.
- Channel opens go through `directory.openChannel("terminal", target)`; release
  goes through `directory.close()`. The adapter keeps only its channel-I/O
  projections (`sendChannel`, `onChannelMessage`, `closeChannel`) that the
  directory entry does not expose.
- The adapter still fails closed with the typed
  `TERMINAL_ADMISSION_UNAVAILABLE` when the connections manager lacks
  `listSessions(link)`.
- Evidence harness `public-entry-matrix.mjs` now resolves the reader catalog
  through the same public entry instead of calling `manager.connect` +
  `manager.listSessions` by hand.

Changed paths:

- `v2/modules/daemon/src/machine-terminal-consumer.mjs` (consume the public entry)
- `v2/evidence/daemon-terminal-admission-1107/composition-20261107/public-entry-matrix.mjs` (reader catalog via the public entry)
- `v2/evidence/daemon-terminal-admission-1107/composition-20261107/connections-directory-entry-probe.mjs` (new real-entry probe)
- `v2/evidence/daemon-terminal-admission-1107/composition-20261107/connections-entry-20261108/` (receipts)

Focused verification (all in the task worktree):

- `node --test v2/modules/connections/tests/contract/public-runtime.contract.test.mjs`: 6/6 PASS, exit 0.
- `node --test v2/modules/daemon/tests/machine-terminal-consumer.test.mjs`: 9/9 PASS, exit 0.
- `node --test v2/modules/members/tests/members.test.mjs`: 29/29 PASS, exit 0.
- `node --test v2/modules/daemon/tests/terminal-admission.test.mjs`: 20/20 PASS, exit 0.
- `node --test v2/modules/daemon/tests/terminal-slice.test.mjs`: 3/3 PASS, exit 0.
- 8-file composition suite: 76/76 PASS, exit 0.
- `public-entry-matrix.mjs` (now resolving the catalog via the public entry): 10/10 PASS.
- Real-entry probe `connections-directory-entry-probe.mjs` against a real V1 mux
  fixture with the real `V1TraversalTransport`: directory resolve returns 2
  machine-scoped `tmux:v1:...` entries with 0 channel opens; one explicit
  `directory.openChannel("terminal", target)` produces exactly 1 channel open on
  the same `LinkRef`; `directory.close()` releases it. exit 0.
- `node --check` on the three changed/added `.mjs` files: PASS, exit 0.
- `node ./scripts/check-repo-layout.mjs`: PASS (daemon consumes connections via
  its public entry; no private import).
- Four affected DAGs validate: `workspace.control_plane`, `workspace.member_resolve`,
  `daemon.connection_channel_catalog`, `daemon.input_schedule`. exit 0.

Raw receipts: `connections-entry-20261108/` (`connections-public-runtime.txt`,
`machine-terminal-consumer.txt`, `members.txt`, `terminal-admission.txt`,
`terminal-slice.txt`, `composition-suite.txt`, `public-entry-matrix.txt`,
`connections-directory-entry-probe.json`, `node-check.txt`, `repo-layout.txt`,
`dagpipe.txt`, with matching `.exit` files).

Remaining gap (unchanged owner boundary): the connections `authorizationPort`
and the accounts grant are still an injected dev authorization in this
composition tree, because the accounts candidate `abfaa4c6` has an open P1
(grant does not verify the target account/machine) and Kate is reworking it. The
daemon and connections directories are now consumed through their real public
entries; the accounts owner entry stays a follow-up candidate. Startup/config
assembly and real input execution output also remain.

The task stays `working/INCOMPLETE`. No push, PR, publish, merge to main,
shared daemon restart, tmux/global service action, or device action was
performed.

## 2026-11-08 reviewed accounts and connections baseline consumption

This section supersedes the earlier `abfaa4c6` / connections link-leak
remainder above.

Reviewed candidates consumed into this composition branch:

- accounts `accounts-authority-runtime-entry-20261108` @ `7630f4a1`
  (Grace ACCEPT), merge `92ea150e`; replaces the old unreviewed `abfaa4c6`.
- connections `connections-authority-runtime-entry-20261108` @ `598875dd`
  (Mia ACCEPT), merge `4ee35232`; replaces old `317a8d3c`.

Rechecked from `/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107`:

- accounts focused public-runtime + real relay: 8/8 PASS, exit 0.
- accounts full suite: 72/72 PASS, exit 0.
- real relay integration: 3/3 PASS, exit 0.
- connections public-runtime contract: 8/8 PASS, exit 0, including:
  - closes the link and preserves the typed catalog error on failure.
  - preserves the original catalog error when a concurrent connect supersedes
    the pending link.
- `node --test v2/modules/connections/tests/contract/public-runtime.contract.test.mjs v2/modules/daemon/tests/machine-terminal-consumer.test.mjs v2/modules/members/tests/members.test.mjs v2/modules/daemon/tests/terminal-admission.test.mjs v2/modules/daemon/tests/terminal-slice.test.mjs`: 61/61 PASS, exit 0.
- `public-entry-matrix.mjs`: all cases PASS, exit 0 (10/10 observation family).
- real `connections-directory-entry-probe.mjs`: 2 entries; resolve opened 0
  channels; explicit open produced exactly 1 channel; `close()` released the
  link; exit 0.
- `node --check v2/modules/connections/src/public/index.mjs`: PASS, exit 0.
- `workspace.control_plane@0.1` and `workspace.member_resolve@0.1` DAG
  validation: PASS, exit 0.
- repo layout gate and `git diff --check`: PASS, exit 0.

The injected-dev accounts blocker and the connections catalog-failure link leak
are cleared for this composition tree. The composition and parent tasks remain
`working/INCOMPLETE` because startup/config assembly and real input-output
execution are still outside this increment. No push, publish, remote merge, PR,
daemon restart, tmux, or shared-port action was performed.

## 2026-11-08 daemon test public-error-contract fix (Jack round 40)

Jenny's message `m1794131626621-1431` routed Jack's round-40 finding that daemon
tests still imported the errors private implementation
(`../../errors/src/typed-error.mjs`).

Verified against this composition branch:

- `v2/modules/daemon/tests/control-plane-composition.test.mjs` already imports
  `TypedError` from the public entry
  `../../errors/src/public/index.mjs`. The private path exists only on local
  main `6ad4a335`.
- `v2/modules/daemon/tests/terminal-input-raw.test.mjs` had no private import
  (it was rewritten to the admission contract on 2026-11-08). It still carried
  a hand-written error shape that duplicated the typed-error contract, so it now
  throws the public `TypedError` for the `UNAUTHENTICATED` case. The `401` +
  `UNAUTHENTICATED` behavior is unchanged because `UNAUTHENTICATED` is a daemon
  admission pass-through code.

Changed paths:

- `v2/modules/daemon/tests/terminal-input-raw.test.mjs` (public `TypedError` instead of a duplicated error shape)
- `v2/evidence/daemon-terminal-admission-1107/composition-20261107/public-import-fix-20261108/` (receipts)

Focused verification:

- `node --check v2/modules/daemon/tests/terminal-input-raw.test.mjs`: exit 0.
- `node --test v2/modules/daemon/tests/terminal-input-raw.test.mjs`: 5/5 PASS, exit 0.
- `node --test v2/modules/daemon/tests/control-plane-composition.test.mjs`: 12/12 PASS, exit 0.
- Boundary scan: `rg "errors/src/typed-error\.mjs" v2/modules/daemon` returns no
  matches; every daemon import of the error contract now goes through
  `errors/src/public/index.mjs`.
- Remaining repo-wide private users are `v2/modules/host-adapters/src/tmux/tmux-adapter.mjs`
  and `v2/modules/host-adapters/tests/tmux-adapter.test.mjs`, which are outside
  this task owner scope and not touched.

Receipts: `public-import-fix-20261108/node-check.txt`, `terminal-input-raw.txt`,
`control-plane-composition.txt` with matching `.exit` files.

Separate finding found during this round (not caused by this fix):

`resolveAuthorizedTerminalDirectory` leaks its just-opened link when
`connectionManager.listSessions(link)` rejects. Reproduction against the real
`createConnectionManager` shows `transport.close()` call count 0 after the
failed resolve; the rejected error is surfaced but the physical transport stays
open. The first-discovered implementation point is
`v2/modules/connections/src/public/index.mjs`. The connections owner (Leo/next
routing by Jenny) should confirm whether the link must be closed on the catalog
failure path and add a red test for it; this task did not touch connections.
Probe receipt:
`public-import-fix-20261108/connections-directory-failure-cleanup-probe.txt`.

The task stays `working/INCOMPLETE`. No push, PR, publish, merge to main,
shared daemon restart, tmux/global service action, or device action was
performed.
