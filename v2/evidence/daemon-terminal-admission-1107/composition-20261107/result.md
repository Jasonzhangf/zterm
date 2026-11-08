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
