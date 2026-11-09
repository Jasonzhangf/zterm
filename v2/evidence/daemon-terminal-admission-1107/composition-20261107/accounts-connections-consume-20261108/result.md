# Reviewed baseline consumption receipt: accounts 7630f4a1 + connections 598875dd

## Scope

- Composition branch: `daemon-terminal-admission-20261107`
- Current composition merge commit: `4ee35232`
- Merged reviewed accounts candidate: `accounts-authority-runtime-entry-20261108` @ `7630f4a1` (replaces previous unreviewed `abfaa4c6`), merged at `92ea150e`
- Merged reviewed connections link-leak fix: `connections-authority-runtime-entry-20261108` @ `598875dd` (replaces old `317a8d3c`), merged at `4ee35232`
- connections candidate is Mia ACCEPT; accounts candidate is Grace ACCEPT.
- No push, remote merge, publish, PR, daemon restart, tmux, shared-port, or global install action was performed.
- This receipt covers the code-level re-merge and affected test gates only. The public resolver owner / startup-config assembly / real input-output gap remains outstanding per the board tasks.

## Accounts evidence already merged

Prior verified by Jenny/Grace and recorded in `v2/evidence/accounts-authority-runtime-entry-1107/`:
- public contract focused tests: 5/5
- full accounts suite: 72/72
- real V1 relay end-to-end: 3/3
- DAG `workspace.control_plane@0.1` / `workspace.member_resolve@0.1` validate

Rechecked from this composition branch today:

| Command | Result | Exit |
| --- | --- | --- |
| `node --test v2/modules/accounts/tests/contract/public-runtime.test.ts v2/modules/accounts/tests/integration/accounts-flow.test.ts` | 8/8 PASS | 0 |
| `node --test v2/modules/accounts/tests/contract/*.test.ts v2/modules/accounts/tests/integration/*.test.ts` | 72/72 PASS | 0 |

## Connections evidence merged

Mia-reviewed link-leak fix verified against the current composition branch:

| Command | Result | Exit |
| --- | --- | --- |
| `node --test v2/modules/connections/tests/contract/public-runtime.contract.test.mjs` | 8/8 PASS | 0 |
| `node v2/evidence/daemon-terminal-admission-1107/composition-20261107/connections-directory-entry-probe.mjs` | 2 entries, resolve opens 0 channels, open opens 1, close releases | 0 |
| `node --check v2/modules/connections/src/public/index.mjs` | PASS | 0 |

New contract tests:
- closes the link and preserves the typed error when the catalog read fails
- keeps the original catalog error when a concurrent connect supersedes the pending link

## Whole affected composition suite from this branch

| Command | Result | Exit |
| --- | --- | --- |
| `node --test v2/modules/connections/tests/contract/public-runtime.contract.test.mjs v2/modules/daemon/tests/machine-terminal-consumer.test.mjs v2/modules/members/tests/members.test.mjs v2/modules/daemon/tests/terminal-admission.test.mjs v2/modules/daemon/tests/terminal-slice.test.mjs` | 61/61 PASS | 0 |
| `node v2/evidence/daemon-terminal-admission-1107/composition-20261107/public-entry-matrix.mjs` | 10/10 PASS | 0 |

## Blockers cleared by this step

- injected-dev accounts blocker: cleared for composition consumption; remaining owner routing/public resolver gap still waits Jenny/David review.
- connections link-leak P1: cleared by candidate `598875dd`; do not consume any further unreviewed connections change.

## Remaining gap

- Startup/config assembly and real input-output execution are still outstanding for `daemon-terminal-admission-1107` / `terminal-admission-composition-1107`.
---
Both tasks stay `working` with `completion_missing: review, integration, close` pending David review.
