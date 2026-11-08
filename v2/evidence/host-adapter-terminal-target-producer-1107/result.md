# Host-adapter terminal target producer

## Goal and architecture mapping

- Goal: the V2 tmux host probe returns the same authoritative `tmux:v1:` stable identity domain as the V1 Android daemon catalog.
- Existing business DAG: `v2/docs/dagpipe/graphs/workspace-control-plane.graph.json`, node `观测成员宿主状态` (`status.member.observe`). The existing graph is closed with one source, one sink, and the `arc.control_projection` output. No topology change is needed.
- Resource: `resource.backend_session` provides the observed native session. The host-adapter public probe projects `{backend, stableId}` for the existing members binding and exact-match resolver.
- Unique owners: `v2/modules/host-adapters/src/tmux/tmux-adapter.mjs` reads tmux endpoint facts; `v2/modules/host-adapters/src/public/tmux-host-probe.mjs` builds the public terminal target.
- Gap class: repair the producer value in an existing edge. Do not add a resolver, alias parser, fallback, or second identity domain.
- Identity contract: `android/src/server/terminal-source-adapter.ts` owns `tmux:v1:` and the key order `backend`, optional `socketPath`, `serverPid`, `sessionId`, `createdAt`.
- Required gates: focused host-adapter tests plus syntax checks on changed `.mjs` files. The members and daemon modules are forbidden paths for this task.

## Changed paths

- `v2/modules/host-adapters/src/tmux/tmux-adapter.mjs`
- `v2/modules/host-adapters/src/public/tmux-host-probe.mjs`
- `v2/modules/host-adapters/tests/host-probe.test.mjs`
- `v2/modules/host-adapters/DESIGN.md`
- `v2/modules/members/tests/members.test.mjs` (test-only follow-up)
- `v2/evidence/host-adapter-terminal-target-producer-1107/`

## Red evidence

Command:

```sh
node --test v2/modules/host-adapters/tests/host-probe.test.mjs
```

Exit code: `1` (`red.exit`).

The new assertion failed before the implementation:

```text
not ok 1 - tmux host probe observes the exact session_id target
error: 'stableId must use the tmux:v1: prefix'
not ok 4 - tmux host probe reports anchorPresent false for a missing pane
error: 'stableId must use the tmux:v1: prefix'
```

Full output: `red.txt`.

## Green evidence

Changed `.mjs` syntax checks all exited `0`:

```sh
node --check v2/modules/host-adapters/src/tmux/tmux-adapter.mjs
node --check v2/modules/host-adapters/src/public/tmux-host-probe.mjs
node --check v2/modules/host-adapters/tests/host-probe.test.mjs
```

Exit receipts: `check-tmux-adapter.exit`, `check-tmux-host-probe.exit`, and `check-host-probe-test.exit`. The corresponding `.txt` files are empty because `node --check` produced no diagnostics.

Focused host-adapter suite:

```sh
node --test v2/modules/host-adapters/tests/host-probe.test.mjs v2/modules/host-adapters/tests/tmux-adapter.test.mjs
```

Exit code: `0` (`green.exit`). Result: `8` tests passed, `0` failed. Full output: `green.txt`.

The test parses the encoded JSON and checks:

- `backend === 'tmux'`
- non-empty string `serverPid`
- `sessionId` equals the probe's observed raw `$N`
- finite numeric `createdAt`
- `stableId` is neither the raw `sessionId` nor the session name

The implementation reads the real tmux fields `#{pid}` and `#{socket_path}`. The socket path is included only when that real field is non-empty.

## DAG checks

Both existing graphs validate with exit code `0`:

```sh
dagpipe graph validate v2/docs/dagpipe/graphs/workspace-control-plane.graph.json
dagpipe graph validate v2/docs/dagpipe/graphs/workspace-member-resolve.graph.json
```

Outputs: `dag-workspace-control-plane.txt` and `dag-workspace-member-resolve.txt`.

## Remaining gap

The broader members suite was run as an observation only:

```sh
node --test v2/modules/members/tests/members.test.mjs
```

It exits `1` (`members-suite.exit`) with `28` passing and `1` failing. The original failure is the stale assertion at `v2/modules/members/tests/members.test.mjs:1279`:

```text
The input did not match the regular expression /^\$[0-9]+$/
```

That test still expected a raw `$N` from the real host-adapter probe. Full output: `members-suite.txt`.

## Follow-up: authoritative members expectation

The red run above was repeated before the test-only correction:

```sh
node --test v2/modules/members/tests/members.test.mjs
```

Exit code: `1`. Result: `28` passed, `1` failed. The failure was the stale raw-`$N` assertion in the real-producer test. The producer returned `tmux:v1:<encoded JSON>`.

The exact members test change is:

```js
// The observed stableId is the authoritative tmux identity, not the session name.
const observedIdentity = JSON.parse(decodeURIComponent(bound.terminalTarget.stableId.slice('tmux:v1:'.length)));
assert.ok(bound.terminalTarget.stableId.startsWith('tmux:v1:'));
assert.equal(observedIdentity.backend, 'tmux');
assert.ok(typeof observedIdentity.serverPid === 'string' && observedIdentity.serverPid.length > 0);
assert.match(observedIdentity.sessionId, /^\$[0-9]+$/);
assert.ok(typeof observedIdentity.createdAt === 'number' && Number.isFinite(observedIdentity.createdAt));
```

This replaced the stale `assert.match(bound.terminalTarget.stableId, /^\$[0-9]+$/)` and its old comment. The test decodes the text after `tmux:v1:` with `decodeURIComponent` and `JSON.parse`. It keeps the existing `assert.notEqual(..., sessionName)` check and the `observedStableId` reuse for verify and restore. No members runtime, resolver, or other members test changed.

Follow-up checks:

| Check | Command | Exit | Output |
|---|---|---:|---|
| Host-adapter suites | `node --test v2/modules/host-adapters/tests/host-probe.test.mjs v2/modules/host-adapters/tests/tmux-adapter.test.mjs` | `0` | `followup-host-adapters-suite.txt`; `8` passed, `0` failed |
| Members suite | `node --test v2/modules/members/tests/members.test.mjs` | `0` | `followup-members-suite.txt`; `29` passed, `0` failed |
| Syntax checks | `node --check` on `tmux-adapter.mjs`, `tmux-host-probe.mjs`, `host-probe.test.mjs`, `members.test.mjs` | `0`, `0`, `0`, `0` | `followup-node-check.txt`; exits in `followup-node-check.exit` |
| Diff check | `git diff --check` | `0` | `followup-git-diff-check.txt`; exit in `followup-git-diff-check.exit` |

All four follow-up outputs and their exit codes are saved in this evidence directory.

## Local commit

The complete change was committed locally on branch `host-adapter-terminal-target-producer-20261107` as `fix(v2/host-adapters): emit tmux:v1 terminal identity`. The first candidate commit is `de0cbd16408ab7e99389afeca8c3312436d0fc40` (`de0cbd16`). That ID was recorded in `commit.txt` at that time; the current candidate is recorded in `rework-commit.txt`.

No push, merge, PR, publish, remote CI, daemon restart, tmux restart, global install, or broad process kill was performed. The producer and members consumer now pass the affected suites. Remote integration and delivery remain outside this local-commit scope.

## Rework 1108: backend coherence P1

### Finding and fix

Review P1: `createTmuxHostProbe` accepted any non-empty `backend` and projected it into `terminalTarget.backend`, while `stableId` was always in the `tmux:v1:` domain. A caller could pass `backend: "herdr"` and receive a contradictory target.

Fix: `createTmuxHostProbe` now rejects every non-`tmux` backend with a `TypeError` before constructing the probe. The returned `terminalTarget.backend` is therefore always `tmux` and coherent with the `tmux:v1:` stableId. The public signature and all existing callers are unchanged; no caller passes a non-tmux backend. `DESIGN.md` records this invariant.

The second reviewer finding (members runtime boundary) was rejected by Jenny per the board description; the members runtime changes are preserved outside this rework.

### Red evidence

Command:

```sh
node --test v2/modules/host-adapters/tests/host-probe.test.mjs
```

Exit code: `1` (`rework-red.txt`). The new test failed before the fix:

```text
not ok 2 - tmux host probe rejects a non-tmux backend at creation
error: 'Missing expected exception (TypeError).'
```

### Green evidence

| Check | Command | Exit | Result |
|---|---|---:|---|
| Host-adapter suites | `node --test v2/modules/host-adapters/tests/host-probe.test.mjs v2/modules/host-adapters/tests/tmux-adapter.test.mjs` | `0` | `9` passed, `0` failed (`rework-green.txt`) |
| Members suite | `node --test v2/modules/members/tests/members.test.mjs` | `0` | `29` passed, `0` failed (`rework-members-suite.txt`) |
| Syntax checks | `node --check` on `tmux-adapter.mjs`, `tmux-host-probe.mjs`, `host-probe.test.mjs`, `members.test.mjs` | `0` for all four | `rework-check-*.exit` / `.txt` |
| Diff check | `git diff --check` | `0` | `rework-git-diff-check.txt` |
| DAG validate | `dagpipe graph validate` on `workspace-control-plane.graph.json` and `workspace-member-resolve.graph.json` | `0` for both | `dag-workspace-control-plane.txt`, `dag-workspace-member-resolve.txt` |

The host-adapters suite grew from `8` to `9` tests because this rework adds the invalid-backend rejection test required by the review remediation. The members suite remains `29` tests and still passes its tmux consumer checks unchanged.

The rework was committed locally on branch `host-adapter-terminal-target-producer-20261107` as `fix(v2/host-adapters): reject non-tmux host probe backend`. The rework code commit is `ddb115e1b30243151719f59c0424d828df966868` (`ddb115e1`), recorded in `rework-commit.txt`; the candidate HEAD that includes this receipt is `a6808e0d2ffc1e2886b46d2d9a69b4378b5ff804` (`a6808e0d`). No push, merge, PR, publish, daemon restart, tmux restart, or global install was performed.

### Changed paths for this rework

- `v2/modules/host-adapters/src/public/tmux-host-probe.mjs`
- `v2/modules/host-adapters/tests/host-probe.test.mjs`
- `v2/modules/host-adapters/DESIGN.md`
- `v2/evidence/host-adapter-terminal-target-producer-1107/` (rework evidence)

No members runtime, daemon, resolver, shared resource, or other module changed.

### Remaining risk

The probe still has no authoritative machine-identity source; `machineId` remains an explicitly injected nullable fact. Broader daemon composition and herdr integration stay outside this producer scope.
