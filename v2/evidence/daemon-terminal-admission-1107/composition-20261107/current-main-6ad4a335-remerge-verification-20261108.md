# terminal-admission-composition-1107 re-merge onto local main 6ad4a335

Date: 2026-11-07 (PST) / 2026-11-08 (UTC)
Composition worktree: /Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107
Branch: daemon-terminal-admission-20261107

## What changed

Local main advanced two commits past the previous candidate base (2bc9bab5):

- 178e1b68 fix(v2): declare public entries for errors/status/terminal
- 6ad4a335 fix(v2/terminal): export projection helpers used by public entry

Both touch exactly the foundation public-boundary files this candidate already
carries. Merged local main into the candidate with `git merge main --no-edit`.

- Merge commit: adf3ba23
- Result: no conflicts; only `v2/modules/daemon/src/server.mjs` auto-merged.
- Content check vs main: the only remaining difference is the admission layer
  this candidate adds. The public-entry content (errors/status/terminal
  `src/public/index.mjs`, `terminal-port.mjs`, `v1-mux-client.mjs`, and the
  three DESIGN public-contract sections) is byte-identical to main.
- `createTerminalAdmission` import and gating remain present in `server.mjs`
  (2 occurrences), so the merge did not drop admission.

## Verification after re-merge

- `node --check` PASS on all 14 touched/added `.mjs` sources and tests.
- Focused composition suite (members + terminal-admission +
  terminal-admission-fail-closed + terminal-slice + terminal-input-raw +
  machine-terminal-consumer + host-probe): 73 tests / 73 pass / 0 fail.
  Receipt: composition-suite-main-6ad4a335.txt.
- Real composition probe re-run against the merged tree:
  host-producer-composition-probe-main-6ad4a335.json
  - injected verified identity -> `bindSession` persists observed target
    `{backend:"tmux", stableId:"$0"}` with `bindingGeneration` 1.
  - missing identity -> typed `BINDING_HOST_IDENTITY_UNAVAILABLE`, no binding
    and no generation written.
  - daemon catalog domain still `tmux:v1:<url-encoded identity>` vs probe raw
    `$N`; the domain gap is unchanged by this merge.
- Project DAGs still validate on the merged tree (`dagpipe graph validate`):
  daemon.input_schedule@0.1 (11 nodes/14 edges/5 waves) and
  daemon.connection_channel_catalog@0.1 (19 nodes/24 edges/10 waves), exit 0.
  Receipt: dagpipe-main-6ad4a335.txt.

## Remaining

The producer-vs-catalog stableId domain gap still needs a master routing
decision and one owning boundary. No shim, second parser, or weakened assertion
was added. Other production gaps (accounts login/grant/revocation, production
daemon bootstrap, committed frame + real input, David review/integration) are
unchanged and owned outside this merge.

No push, PR, merge to main, publish, shared daemon restart, tmux/global service
action, or device action was performed.
