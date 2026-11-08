# daemon-terminal-admission-1107 task log

## Long-term goal

The V2 daemon must expose one exact remote terminal session to an authenticated
caller only after account, workspace, member, and runtime-binding admission.
The daemon must open the existing catalog target with `existingOnly` and must
not forward input before admission.

## 2026-11-07 02:00 PT - orientation

Purpose: confirm the dispatched branch, base, scope, and the current daemon
terminal routes before changing code.

Evidence:

- Worktree `/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107`
- Branch `daemon-terminal-admission-20261107`
- Base `f99a61a8`
- Scope `v2/modules/daemon/src/**` and `v2/modules/daemon/tests/**`

Findings:

- `v2/modules/daemon/src/server.mjs` exposes `/api/sessions`,
  `/api/terminal/stream?target=...`, and `/api/terminal/input`.
- The terminal routes only call the daemon-local `authenticate()` (static V2
  token or cookie session). They do not verify workspace authorization, resolve
  a member, read the runtime binding, reject a stale generation, or check the
  exact catalog backend + stableId.
- `TerminalPort.input(target, data)` resolves a catalog session and opens the
  V1 mux channel with `existingOnly: true` and
  `expectedSessionIdentity: stableId`.

Progress: the missing layer is explicit admission between daemon authentication
and terminal channel open.

Next: audit the two affected DAG graphs and map the admission into the existing
input path.

## 2026-11-07 02:05 PT - DAG audit and architecture mapping

Purpose: verify the affected path is closed and SESE, and state how the change
maps to the current DAG.

Evidence source: `android/docs/dagpipe/daemon-connection-channel-catalog.graph.json`
and `android/docs/dagpipe/daemon-input-schedule.graph.json`.

Commands and results:

- `dagpipe graph validate android/docs/dagpipe/daemon-connection-channel-catalog.graph.json`
  -> exit 0, `valid DAG: daemon.connection_channel_catalog@0.1 (19 nodes, 24 edges, 10 waves)`
- `dagpipe graph validate android/docs/dagpipe/daemon-input-schedule.graph.json`
  -> exit 0, `valid DAG: daemon.input_schedule@0.1 (11 nodes, 14 edges, 5 waves)`

Mapping:

- Business graph: `daemon.connection_channel_catalog`. The exact catalog target
  is the `build_session_catalog` output. The existing-only open remains the
  terminal channel open edge, not a client session owner.
- Execution graph: `daemon.input_schedule`. Admission is a precondition on
  `dagpipe.extract.arc.channel_input_event`; it does not add a new node,
  branch, or output. The admitted input still enters `enqueue_channel_input`
  and `terminal.daemon_input.write`.
- Unique owner: the daemon composition root owns HTTP admission. Authorization
  and binding resolution stay in the public `routing` `resolve()` port, which
  consumes the public `organization` and `members` readers. The daemon must not
  copy organization/members truth.
- Gap class: add a link (admission precondition) in the daemon route. This is
  not a graph topology change, so no graph file edit is needed.
- Gate: `node --test v2/modules/daemon/tests/terminal-admission.test.mjs` and
  `node --test v2/modules/daemon/tests/terminal-slice.test.mjs`.

Progress: the graph path is valid and the admission belongs in the daemon
composition layer.

Remaining gap: no red test yet, no admission code yet.

Next: write the focused red test that sends an unadmitted legacy terminal input
through the daemon public route while routing is configured, and capture the
failure before implementation.

## 2026-11-07 02:15 PT - implementation and green acceptance

Purpose: implement the smallest daemon-owned terminal admission path and verify
both the new admission route and the preserved legacy route through the public
HTTP entry.

Evidence source: this note, `red-bypass.txt`, `admission-test.txt`,
`terminal-slice-test.txt`, and `receipts.txt`.

Results:

- Red evidence: the unmodified daemon accepted a legacy `{ target: name, data }`
  input with `200`; the test expected `400`. See `red-bypass.txt`.
- The production route now requires caller verification, workspace/member
  authorization through public routing, the current runtime binding through the
  public members reader, current binding generation, and an exact live catalog
  `{ backend, stableId }` before opening the channel or forwarding input.
- `/api/terminal/input` forwards a typed operation only after admission.
  `/api/terminal/stream` admits first and then subscribes to the admitted
  session.
- Legacy behavior remains unchanged when `admission` is not injected: token and
  cookie authentication, target validation, existing-only terminal resolution,
  and CSRF still work as before.
- Focused admission test: 9/9 passed, exit 0.
- Legacy terminal slice single-run: 3/3 passed, exit 0. One parallel execution
  observed the existing exact-line `captureAfterInput` assertion fail after
  `waitFor()` had already passed; this is pre-existing timing flake in the old
  test, not an admission failure, and is kept in `terminal-slice-test.txt`.

Progress: the required route behavior and typed failures are implemented and
contract-tested.

Remaining gap: `main.mjs`/`startDaemon` does not yet accept or compose the
public `accounts`/`routing`/`members` admission ports, so the new path is not
activated for the production CLI daemon. Production activation and any
cross-owner routing/members contract reconciliation remain outside this task.

Next: hand the result to the reviewer/master; do not commit, push, merge, or
publish in this worker scope.

## 2026-11-07 19:47 UTC - recovery composition blocker

Purpose: resume from master-confirmed accepted dependencies and test the real
public connections runtime in this task worktree.

Evidence:

- Recovery message `m1794080510009-6726` confirmed the accepted condition.
- Combined shared commit `286a6f32`, dirty connections source, and dirty mux
  host-id source into this worktree without touching upstream worktrees.
- `public-runtime-probe.mjs` -> `createConnectionManager=function`, exit 0.
- Connections type-check -> exit 0. Connections tests -> 41 passed, 2 skipped,
  0 failed. Combined daemon and members suites -> 53 passed, 0 failed.
- `catalog-edge-probe.mjs` -> real `ConnectionManager.listSessions=undefined`,
  daemon consumer fails typed `TERMINAL_ADMISSION_UNAVAILABLE`
  (`connections-catalog-missing`) with zero channel open or input side effects.

Progress: accepted shared/connections dependencies are combined and pass their
own checks. The remaining catalog edge is missing in the accepted connections
public runtime.

Blocking decision: do not edit connections source in this task. Stop the real
accounts/connections/terminal admission step and report the precise blocker,
worktree, probe path, and typed failure to Jenny. Task remains `working`,
`INCOMPLETE`, and undelivered.

## 2026-11-07 17:33-18:00 UTC - composition rework: fail-closed + consumer adapter

Purpose: implement the adjudicated composition plan (m1794072760928-5840,
m1794073275779-5913, m1794073348389-5918). Jenny accepted the plan structure
and rejected the accounts-identity fallback in Gap 4; peer identity must stay
fail-closed. Do not edit connections in this task.

Changes (daemon worktree only):

- `v2/modules/daemon/src/server.mjs`: `/api/terminal/stream` and
  `/api/terminal/input` now call `requireTerminalAdmission(context, op)` which
  throws typed `TERMINAL_ADMISSION_REQUIRED` (503) when admission is absent.
  Removed the token-only legacy branch from both routes: the `authenticate()`
  fallback, the `target=` query fallback, and the legacy CR-appending input
  path are gone. `statusForError` maps `TERMINAL_ADMISSION_REQUIRED` to 503.
- `v2/modules/daemon/src/machine-terminal-consumer.mjs` (new): projects a
  connections ConnectionManager into the machine-scoped terminal consumer
  (`forMachine({machineId}) -> {machineId, status, freshness, peerIdentityVerified,
  daemonHostId, linkGeneration, listSessions, input, subscribe, close}`). It owns
  no connection/catalog truth. `listSessions(link)` is the connections-public
  catalog read; missing edge returns typed `TERMINAL_ADMISSION_UNAVAILABLE`.
  Unverified peer identity returns `peer_identity_mismatch` and closes the link.
  `input`/`subscribe` map stableId -> exact-existing terminal channel
  (`expectedSessionIdentity=stableId, existingOnly, bodySubscribed`).
- Tests: `terminal-admission-fail-closed.test.mjs` (2), `machine-terminal-consumer.test.mjs`
  (6), and the updated `terminal-slice.test.mjs` repurposed to the fail-closed
  contract. `node --test` on the four daemon suites -> 31 passed, 0 failed.

Dependency update (from m1794074431901-6038):

- The real production composition of connections public entry must wait for
  `shared-runtime-resolvability-1107` (P1, independent GCM worker,
  worktree `shared-runtime-resolvability-20261107`) and its David review.
- `connections-public-runtime-1107` owns the connections catalog/`.ts`
  consumability edge; `mux-ready-daemon-host-id-1107` owns `daemonHostId`.

Status: INCOMPLETE. Fail-closed route + consumer adapter prove the admitted
contract at module level, but the real isolated V1 + accounts + connections +
members path (stream/input plus revoke/rebind/wrong-identity rejection) does not
exist yet because the connections public entry is not consumable. No push/merge/
publish/PR; 8899/3333/8801, tmux 16906, 15T untouched.

## 2026-11-07 19:02 UTC - standby on connections public entry (m1794078133274-6351)

Master confirms task is standby: `connections-public-runtime-1107` (Kate) is
fixing `v2/modules/connections/src/index.ts` extensionless imports and
`v1-traversal.ts:93` parameter-property syntax. Do not integrate the real
connections public entry before Kate delivers raw RED/GREEN and David review
passes; do not substitute the fixture for completion. Board next_step updated.
`shared-runtime-resolvability-1107` is delivered but review is still pending;
`mux-ready-daemon-host-id-1107` is accepted with review PASS. Resume condition:
Kate delivery + David review PASS + shared-runtime review PASS.

## 2026-11-07 03:15 PT - admission translation fix and public entry propagation

Purpose: verify the latest code and close the remaining public-entry gap.

Evidence source: this note, `admission-test.txt`,
`terminal-slice-test.txt`, `terminal-slice-test-rerun.txt`, and `receipts.txt`.

Changes since the last entry:

- Removed the unnecessary no-op `finally` around the public members
  runtime-binding read.
- Fixed the typed-failure translation ordering: a public routing
  `ROUTE_NOT_FOUND` is now mapped to `MEMBER_NOT_FOUND` before the generic
  public `TypedError.toRecord()` branch, so unknown member reaches the daemon
  public route as a typed 404 instead of an untyped 500.
- `startDaemon` in `main.mjs` now accepts and forwards `admission` to
  `createDaemon`, so the public daemon entry can activate the admission path.
- Added the focused HTTP test that proves `startDaemon({ admission })` gates
  input through admission.

Results:

- `node --test v2/modules/daemon/tests/terminal-admission.test.mjs`
  -> 10 passed, 0 failed, exit 0.
- `node --test v2/modules/daemon/tests/terminal-slice.test.mjs`
  -> isolated rerun 3 passed, 0 failed, exit 0.
- One sequential rerun of the legacy slice still showed the pre-existing
  exact-line `captureAfterInput` flake after `waitFor()` had already passed.
  The raw failing output is preserved; the isolated rerun is green.

Progress: the daemon admission path is contract-tested green through both
`createDaemon` and `startDaemon`, with all required typed failures.

Remaining gap: the production CLI bootstrap still does not construct the real
account/organization/member/routing stores, so the shipped daemon process does
not yet enable admission end-to-end by itself.

Next: hand the result to the reviewer/master; do not commit, push, merge, or
publish in this worker scope.
