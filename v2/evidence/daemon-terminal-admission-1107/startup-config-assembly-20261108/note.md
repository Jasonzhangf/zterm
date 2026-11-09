# startup-config-assembly-1107-r2 task log

## Long-term goal

The V2 daemon production startup path must assemble the real public modules
(accounts, organization, members, routing, connections, host-adapters) from a
single config file and expose admitted terminal input/stream only through
`main.mjs --config`. The assembled daemon must fail closed on missing config,
missing host probe, missing binding resolver, wrong target, stale binding
generation, and wrong machine, and must produce zero terminal side effects on
every typed failure.

## 2026-11-08 04:19 PT - orientation

Purpose: confirm the dispatched worktree, base, scope, and the public-transport
dependency before running the real daemon black box.

Evidence:

- Worktree `/Volumes/Intel/playground/zterm/worktrees/terminal-admission-startup-config-20261108`
- Branch `terminal-admission-startup-config-20261108`
- Base `416661d5`, HEAD `36de5b25`
- Allowed writes: `v2/modules/daemon/src/**`, `v2/modules/daemon/tests/**`,
  `v2/evidence/daemon-terminal-admission-1107/startup-config-assembly-20261108/**`
- All other modules are read-only; `36de5b25` is an accepted isolated dependency.

Findings:

- `v2/modules/daemon/src/startup-config.mjs` composes all eight required
  sections and fails closed with `DAEMON_STARTUP_CONFIG_INVALID` before any
  module opens a network socket.
- `v2/modules/daemon/src/main.mjs` now wires `loadStartupConfig` through the
  real `--config` / `ZTERM_V2_CONFIG` entry and prints one listening receipt.
- `v2/modules/connections/src/public/index.mjs` (from `36de5b25`) exports the
  real `V1TraversalTransport`, so the daemon no longer needs a cross-owner
  private import.
- `node --test v2/modules/daemon/tests/startup-config.test.mjs` -> 8/8 pass,
  exit 0 (re-run in this recovery).

Progress: composition source and focused tests are in place.

Remaining gap: no real config, no real listening receipt, no admitted
input/stream green receipt, no six typed-failure receipts, no zero-side-effect
proof.

Next: run the real daemon black box with real relay + real V1 + dedicated tmux
socket, capture receipts, then deliver to Mia and report to Jenny.

## 2026-11-08 05:40 PT - real daemon black box

Purpose: prove the assembled daemon through its real production entry in an
isolated environment, then record every receipt under this directory.

Evidence sources:

- `real-blackbox.mjs` and `real-blackbox.json` / `real-blackbox.txt`
- `result.md`
- Raw receipts referenced from `result.md`

Constraints honored:

- No shared daemon (PID 20617 / 8899), no 3333 / 8801 / 8899 / 15T.
- Only task-owned tmux sessions on a dedicated socket; the wrapper blocks any
  other socket. No `tmux kill-server`, no batch kills, no shared server action.
- No push, merge, publish, PR, or public-contract change.
- Secrets never written to receipts; access token is redacted.

Method:

- Real relay: `android/src/traversal-relay/server.ts` (spawn via tsx from the
  existing accepted worktree `daemon-terminal-admission-20261107`, which also
  supplies `android/node_modules`).
- Real V1 daemon: `android/src/server/server.ts` (same tsx), with a task-owned
  HOME, `ZTERM_DAEMON_SESSION`, `ZTERM_TMUX_BINARY=tmux-isolate.sh`, and
  `ZTERM_FIXTURE_TMUX_SOCKET` pointing at the dedicated socket. The V1 daemon
  advertises a stable `daemonHostId` from `ZTERM_TRAVERSAL_HOST_ID`.
- Host probe reaches the same dedicated tmux server through a `tmux-<uid>` /
  `<socketName>` symlink inside `TMUX_TMPDIR`, so `-L <socketName>` resolves to
  the exact V1-owned server. No product code change.
- Real V2 daemon: `node v2/modules/daemon/src/main.mjs --config <real config>`,
  with real relay tokens and a grant written into the file authorization store.
- Green path: register, login, enroll machine, grant org/members scopes,
  create workspace, add member, bind the member to the V1 alpha target through
  the real host probe, then post admitted input and subscribe to the admitted
  stream until the marker appears in the served buffer.
- Typed failures: missing config, missing host probe, missing binding resolver,
  wrong terminal target, stale binding generation, and wrong machine. Each
  failure is asserted against the exact HTTP status and typed error code and
  against the recorded channelOpen/input counts (all zero side effects).

Progress: see `result.md` for the actual observed outcome and any remaining gap.
