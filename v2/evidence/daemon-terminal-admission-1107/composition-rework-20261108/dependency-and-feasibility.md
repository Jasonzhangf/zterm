# terminal-admission-composition-1107 rework: dependency and feasibility

Date: 2026-11-08 (UTC)
Owner: Emma (peer)
Task: `terminal-admission-composition-1107` (parent `daemon-terminal-admission-1107`)
Worktree: `/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107`
Branch: `daemon-terminal-admission-20261107`
Candidate: `416661d5842ee88c59fa9cae89e86b7a5ad70c51`

## Purpose

Resume the Mia REWORK_INCOMPLETE rework without duplicating the work that is
owned by an independent branch, and record the exact blockers and the verified
real building blocks. No source change was made in this round.

Reviews driving this round:

- `review-mia-20261108.json` (composition task, verdict REWORK).
- `review-mia-daemon-module-20261108.json` (parent task, verdict REWORK_INCOMPLETE).

Both reviews raise the same three P1 findings.

## P1-1 production CLI assembly: blocked on an independent owner

Finding: `v2/modules/daemon/src/main.mjs` line 62 calls `startDaemon` with only
`port/host/V1 URLs/tokens/webuiDir`; `createDaemon` therefore uses its default
`admission=null`, and the terminal routes return `TERMINAL_ADMISSION_REQUIRED`.

Ownership: the composition-rework contract states the production startup
configuration is completed first by peer Leo on the independent branch
`terminal-admission-startup-config-20261108`; Emma merges the candidate and then
continues composition acceptance. The contract forbids double-writing the same
worktree.

Observed dependency state (read-only):

- `git -C /Volumes/Intel/playground/zterm/worktrees/terminal-admission-startup-config-20261108 rev-parse HEAD`
  -> `416661d5842ee88c59fa9cae89e86b7a5ad70c51` (same baseline as this candidate).
- `git status --short` -> empty (no uncommitted work).
- No commit exists on the branch above the baseline.

Conclusion: P1-1 has no candidate to merge yet. P1-2 depends on P1-1, because it
must run the supported CLI entry with the assembled owners.

## P1-2 real committed frame and unique output: blocked by P1-1

Finding: the positive matrix uses dev-auth and an isolated tmux-backed simulated
V1 mux; the stream assertion stops at `event: ready`, and the marker can be
satisfied by input echo.

Reverification requires the supported daemon entry with real owner modules plus
an isolated real V1 daemon. That entry is P1-1. The required real-backend
capability itself was verified this round (see below), so P1-2 is only waiting
on the P1-1 candidate.

## P1-3 grant revocation on a live transport: all real building blocks verified present

Finding: binding is a harness `bindTarget` call, and the revoked-link case only
closes the fixture socket, proving physical disconnect rather than an accounts
grant revocation on a live transport.

The real building blocks needed to satisfy P1-3 were each verified this round:

- Public host binding producer: `createTmuxHostProbe` (host-adapters public
  entry) observes the live tmux identity; `members.bindSession` persists the
  authoritative `{backend, stableId}` from that observation and refuses a
  caller assertion that disagrees.
- Accounts authority port: `createWorkspaceAuthorization` is reachable from the
  accounts public runtime surface. Node 22.22.2 imports
  `v2/modules/accounts/src/public/contracts.ts` directly and reports
  `createWorkspaceAuthorization=function` with no missing export.
- Real accounts relay: the isolated traversal relay entry
  `android/src/traversal-relay/server.ts` is started by the accepted accounts
  integration test with an isolated port and data dir, and serves the
  `/api/auth/*`, `/api/directory`, `/api/machines` endpoints that
  `V1RelayAdapter` consumes.
- Connections authorization port: `createAccountsAuthorizationPort` /
  `AccountsAuthorizationAdapter` (accounts public contracts) plus the real
  `V1TraversalTransport`.
- Real V1 terminal backend: the isolated real V1 fixture ran green this round.

## Verified real V1 backend run (this round)

Command:

```text
ZTERM_CANDIDATE_ROOT=/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107 \
  node /Volumes/Intel/playground/zterm/.worker-runs/isolated-v1-stream-fixture-1105/run.mjs run
```

Result:

```text
{"status":"PASS","runId":"isolated-v1-59656-mw7rkiad","startedAt":"2026-11-08T11:43:40.402Z","finishedAt":"2026-11-08T11:43:41.394Z","host":"127.0.0.1","port":62106,"tmuxSocket":"/tmp/isolated-v1-59656-mw7rkiad/tmux.sock","alpha":"fixture-alpha-59656","beta":"fixture-beta-59656","candidateRoot":"/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107","realV1Daemon":true,"gates":{"initialFrame":true,"inputEcho":true,"secondTargetIsolation":true,"recoverableInterruption":true}}
```

This proves only the real V1 terminal backend and its gates. It is not product
composition acceptance.

## Open decision needed from Jenny

1. Route the `main.mjs` production assembly candidate (P1-1) from Leo, or
   reassign P1-1 to Emma explicitly and release the no-double-write constraint.
2. Confirm whether P1-3 may be delivered independently with the supported
   `startDaemon` entry plus the real owners above while P1-1 is pending, or must
   wait for the CLI assembly.

No push, merge to main, publish, PR, shared daemon restart, or tmux server
action was performed.
