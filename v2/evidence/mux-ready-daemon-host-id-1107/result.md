# mux-ready-daemon-host-id-1107 result

- Task: mux-ready-daemon-host-id-1107 (V1 mux-ready advertises daemonHostId)
- Baseline revision: f99a61a8f39542afcb450a23ad55060dcbcdd697
- Worktree: /Volumes/Intel/playground/zterm/worktrees/mux-ready-daemon-host-id-20261107
- Reviewer: David. Not self-reviewed and not closed; awaiting review.

## Behavior delivered

The V1 live wire now advertises the configured daemon host identity: a mux-ready
frame emitted for mux-hello carries `payload.daemonHostId` set to the current
non-empty `DAEMON_CONFIG.daemonHostId`. This closes the gap where the accepted V2
connections adapter observed a missing peer identity.

Identity source is unchanged and stays authoritative: relay `hostId`, else the
stable `~/.zterm/daemon-id`. No new identity owner is introduced. The V2 source,
relay state, shared ports, tmux lifecycle, and production deployment were not
touched.

## Changed paths

- android/src/server/server.ts
- android/src/server/terminal-message-runtime.ts
- android/src/server/terminal-message-runtime.test.ts
- android/src/server/terminal-mux-channel-runtime.ts
- v2/evidence/mux-ready-daemon-host-id-1107/

## Red evidence

- `red-mutation.txt`: isolated real daemon probe with `daemonHostId` removed from
  the mux-ready build. Live `mux-hello` -> `mux-ready` returns
  `daemonHostId: null`, `ok: false`, and fails with
  `mux-ready daemonHostId assertion failed: expected=probe-f9e6a68d9f55
  received=(missing)`. Exit code 1.
- `red-test.txt`: focused unit assertion `advertises the current daemon host
  identity in mux-ready` fails before the fix (missing `daemonHostId` in the
  emitted frame). It also shows 6 unrelated failures from a missing
  `zterm-dagpipe` native module captured before the test binary was copied into
  the worktree; those are test-environment noise and are resolved for the green
  run below.

## Green evidence

- `green-probe.txt`: same isolated real daemon probe after restoring the
  pass-through. `mux-hello` -> `mux-ready` returns
  `daemonHostId: "probe-0cb9fbdcdf72"`, matching `expectedHostId`, `ok: true`.
  Exit code 0.
- `green-mux-owner.txt`: android/src/server/terminal-mux-channel-identity.test.ts
  6 passed (6).
- `full-test.txt`: android/src/server/terminal-message-runtime.test.ts
  68 passed (68), including the focused `advertises the current daemon host
  identity in mux-ready` assertion.
- `shared-protocol.txt`: packages/shared/src/connection/protocol.test.ts
  22 passed (22); mux-ready identity remains optional, so non-identity clients
  keep working and the compatibility contract is not weakened.
- `type-check.txt`: `cd android && pnpm exec tsc --noEmit` exit code 0, no errors.
- `git diff --check`: exit code 0, no whitespace/conflict-marker errors.
- `git status --short`: only the 4 intended source/test files plus the evidence
  directory. No stray copied binaries tracked.

## Causality

The only owner-side mutation (removing `daemonHostId` from
`buildTerminalMuxReady`) turns the probe and unit assertion red; restoring that
single pass-through line returns both to green. No compensating edits were used.

## Remaining gaps

- No Android real-device or emulator gate was run: this change is daemon-only
  server wire behavior, verified through the isolated daemon probe and unit
  tests, not a client-visible renderer change.
- No push, merge, publish, PR, or deployment was performed (Git freeze honored).

## Rework (review 2026-11-07)

David issued a scoped REWORK (revision 14) covering the probe only; production
pass-through code is accepted with no finding. Both findings are closed:

1. Home override removed. `probe.mjs` previously set `HOME`/`ZTERM_HOME` to a
   temp dir and wrote `<HOME>/.zterm/daemon-id`, relying on the stable daemon-id
   fallback. The daemon reads `homedir()` only and has no `ZTERM_HOME`
   overwrite entry, so the supported task-specific configuration surface is the
   process-level daemon config env (`daemon-config.ts`:
   `daemonHostId = relay?.hostId || resolveStableDaemonHostId(homeDir)`). The
   probe now supplies `ZTERM_TRAVERSAL_HOST_ID` plus relay credentials, with the
   relay URL pointed at a closed loopback port so no real relay is contacted and
   the reconnect timer stays unref'd. No HOME/ZTERM_HOME override, no production
   config write, no change to the daemonHostId owner.
2. Guaranteed cleanup. The entire post-spawn lifecycle now runs inside one
   try/finally. `waitForServer` receives the child handle and aborts when the
   child exits before readiness. Cleanup kills only the exact spawned child,
   waits for confirmed exit (SIGTERM then SIGKILL fallback), and removes the
   scratch dir only after the child is terminated. No broad kill, no tmux
   action.

Receipts:

- `green-probe-no-home-override.txt`: isolated success. mux-ready carries
  `daemonHostId=probe-d7aa9104d30c` matching `expectedHostId`,
  `identitySource=ZTERM_TRAVERSAL_HOST_ID`, `homeOverride=false`,
  `childExited=true` (exit 0), `scratchDirRemoved=true`, `ok: true`.
- `startup-failure-cleanup.txt`: forced startup failure (EADDRINUSE -> exit 78).
  Cleanup observed `childExited=true`, `exitCode=78`, `scratchDirRemoved=true`,
  `ok: true`.

Prior causal evidence (`red-test.txt`, `red-mutation.txt`, `full-test.txt`,
`green-mux-owner.txt`, `shared-protocol.txt`, `type-check.txt`) is retained
unchanged; `green-probe.txt` is the earlier HOME-based run and is superseded by
`green-probe-no-home-override.txt` for the probe contract.

## Rework recheck correction (2026-11-07)

David's targeted recheck found one remaining probe-only cleanup gap:
`stopOwnedChild` could return `exited=false`, but the `finally` block still
removed the scratch directory unconditionally, and success-mode acceptance only
checked the mux identity.

The probe now routes scratch finalization through `cleanup-receipt.mjs`:

- If `childResult.exited !== true`, the scratch directory and transcript are
  preserved, `scratchDirRemoved=false`, and cleanup returns `ok=false` with an
  explicit reason.
- The scratch directory is removed only after the exact owned child has exited.
- Success-mode `ok` requires the live mux identity match and the completed
  cleanup result (`cleanup.ok=true` and `cleanup.exited=true`).
- The controlled helper `verify-cleanup-refusal.mjs` tests the false branch
  without spawning a daemon. It proves that a fake non-exited child causes
  `cleanup.ok=false`, keeps the owned data file, and reports
  `scratchDirRemoved=false`.

New receipts:

- `cleanup-refusal-helper.txt`: controlled false-exit branch;
  `realDaemonSpawned=false`, `sentinelPreserved=true`,
  `scratchPreserved=true`, `cleanup.ok=false`, test `ok=true`, exit 0.
- `green-probe-cleanup-ok.txt`: current isolated success probe. The mux-ready
  identity matches, `childExited=true`, `scratchDirRemoved=true`,
  `cleanup.ok=true`, and final `ok=true`.
- `startup-failure-cleanup-confirmed.txt`: current forced startup failure
  (exit 78). `forcedFailureObserved=true`, `childExited=true`,
  `scratchDirRemoved=true`, `cleanup.ok=true`, final `ok=true`.

No production source changed for this correction. `node --check` passed for
`probe.mjs`, `cleanup-receipt.mjs`, and `verify-cleanup-refusal.mjs`.
Three stale empty/daemon-id-only scratch directories left by the earlier
HOME-based probe were removed by exact path; no current probe scratch remains.
