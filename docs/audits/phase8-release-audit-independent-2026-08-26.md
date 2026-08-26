# Phase 8 Release Audit: Independent Verification

- Date: 2026-08-26
- Auditor: pane-552
- Run: `20260826T224900Z-Macstudio-pane552-phase8audit`
- Base: `1fd62456a14ebf7ed4a0d726d806a5a49f93fab2`
- Worktree HEAD: `1fd62456a14ebf7ed4a0d726d806a5a49f93fab2`
- `origin/main`: `1fd62456a14ebf7ed4a0d726d806a5a49f93fab2`

## Verified

The declared audit worktree was fast-forwarded from `e1293f9e` to the current
`origin/main`. It is clean, and `git merge-base --is-ancestor HEAD origin/main`
passes.

These root gates pass:

| Gate | Evidence |
| --- | --- |
| Map registries | `node scripts/check-zterm-v2-map-registries.mjs` |
| Cordis governance | `pnpm run test:cordis-v2-governance` (`9` phases, `9` nodes, `8` edges, `6` active gates) |
| Repository layout | `pnpm run test:repo-layout` |
| Parity catalog | `pnpm run test:v2-parity-catalog` (`75` features, `3` platforms) |
| Diff check | `git diff --check` |
| Main/origin identity | both resolve to `1fd62456a14ebf7ed4a0d726d806a5a49f93fab2` |

The initial `test:v2:parity-catalog` invocation was a nonexistent script name;
the repository's declared script is `test:v2-parity-catalog`, which passed.

## Commit and Handoff Audit

The current main history includes the phase 7 Windows manifest correction and
the Phase 8 runtime/release audit drafts:

- `d5d85165`: adds `zterm.v2.phase7.windows.live` to Phase 7
  `delivered_claims`.
- `6512b3aa`: records runtime replay blockers.
- `a9a6f666`: records the release audit draft and gaps.
- `1fd62456`: merges the runtime replay audit branch.

The phase manifest is internally consistent for the known state:

- Phases 0-6: `complete`.
- Phase 7: `active`, with desktop parity, iOS device contract, and Windows
  claims listed as delivered.
- Phase 8: `blocked-on-phase-7`, with no delivered claims.

Validated handoff details include:

| Claim | Commit | Verified state |
| --- | --- | --- |
| `zterm.v2.phase7.windows.live` | `3364a253` | local/package gates pass; live gate blocked |
| `zterm.v2.phase7.ios.device` | `8f72a32f` | contract gates and AGY pass; native live gate absent |
| `zterm.v2.phase7.desktop.parity` | `736a83d4` | static/package gates pass; packaged live gate absent |
| `zterm.v2.phase8.architecture.audit` | `a7832c3a` | static audit merged |
| `zterm.v2.phase8.runtime.replay` | no delivery commit | task remains working and blocked |

The Windows handoff is valid JSON in the current tree (`jq empty` passes).
Its recorded Windows paths are escaped correctly.

## Blocking Findings

1. `zterm.v2.phase7.ios.native` remains `working`. The repository has no
   completed native iOS target or simulator/device terminal replay. The
   `packages/ios-host` tests are contract tests only.
2. `zterm.v2.phase7.windows.live` records local package and daemon-start
   evidence, but real daemon transport/input smoke is blocked by Windows
   firewall access, stale WezTerm mux state, daemon persistence permissions,
   and missing packaging assets. Its handoff explicitly says AGY was not run.
3. `zterm.v2.phase7.desktop.parity` records static/package evidence but no
   packaged CDP smoke.
4. The architecture audit records nine active runtime gates not wired to the
   `cordis-v2-governance` CI job: IPC codec, stale generation, session route,
   persistence settings, terminal transport, terminal buffer render,
   file/media input, low-risk plugin ownership, and desktop packaged parity.
5. The latest task board confirms `phase8.runtime.replay` is `working` and
   `phase7.ios.native` is `working`; therefore Phase 8 cannot be delivered.

## Phase 8 Gate Result

| Gate | Result |
| --- | --- |
| Main-tree verification | PASS for the root gates listed above |
| Staged scope / undeclared dirty | PASS in the audit worktree |
| Push-head equality | PASS for the inspected main/origin heads |
| AGY final review | BLOCKED; required live platform evidence is missing |

Conclusion: this is an independent audit record, not a release approval.
Do not run final AGY or deliver Phase 8 until the iOS native, Windows live, and
Mac packaged evidence gaps are resolved and the runtime replay is completed.
