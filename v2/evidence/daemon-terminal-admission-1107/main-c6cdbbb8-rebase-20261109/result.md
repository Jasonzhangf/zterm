# P1-2/P1-3 Rebase onto current local main

## Baseline

- Source candidate: `terminal-admission-composition-p1-merge-20261109` at `3823a690`
  (code baseline `b6609373`, evidence-only commit `3823a690`)
- Integration base: current local `main` at `c6cdbbb8` (contains `6bea8987`:
  accounts `7630f4a1`, connections `598875dd`, parity workspace `71fbf82d`)
- New integration branch: `terminal-admission-rebased-main-20261109`

## Conflict boundary

`git merge-tree` between `main` and `3823a690` produced real conflicts in
`v2/modules/daemon` and the reviewed composition evidence. The `main` commit
`03d6f8b4` had removed the terminal admission feature as a host-adapter
isolation step; this rebase restores the reviewed P1-2/P1-3 admission semantics
while keeping all other current `main` changes.

- `v2/modules/daemon/**` restored to the reviewed branch version. This is
  `main` plus the reviewed P1-1 startup config and P1-2/P1-3 admission:
  `startup-config.mjs`, `machine-terminal-consumer.mjs`,
  `terminal-admission.mjs`, and their tests.
- `v2/modules/daemon/src/server.mjs`: the two content conflicts in
  `streamTerminal`/`sendTerminalInput` and the typed error status map are
  resolved to the reviewed admission form (`requireTerminalAdmission`,
  `withTerminalAdmission`, admission routes, and admission error mapping).
  Other `main` changes in the same file are preserved.
- `v2/modules/daemon/tests/terminal-input-raw.test.mjs`: resolved to the
  reviewed admission-aware raw-input suite. It keeps exact-byte forwarding,
  typed `400 INPUT_INVALID` with no terminal side effect, and auth/target
  cannot-bypass checks.
- `v2/evidence/daemon-terminal-admission-1107/composition-20261107/**`
  modify/delete conflicts resolved to the reviewed branch versions, so the
  admission evidence trail is retained with the restored feature.
- `v2/modules/connections/src/public/index.mjs`: adds the
  `V1TraversalTransport` public export required by `machine-terminal-consumer`.

No production semantics changed beyond restoring the reviewed admission path.
No push, merge to main, publish, PR, or daemon/tmux lifecycle action.

## Tests

Affected daemon suite:

```text
node --test --test-concurrency=1 \
  v2/modules/daemon/tests/machine-terminal-consumer.test.mjs \
  v2/modules/daemon/tests/startup-config.test.mjs \
  v2/modules/daemon/tests/terminal-admission.test.mjs \
  v2/modules/daemon/tests/terminal-admission-fail-closed.test.mjs \
  v2/modules/daemon/tests/terminal-input-raw.test.mjs \
  v2/modules/daemon/tests/terminal-slice.test.mjs \
  v2/modules/daemon/tests/control-plane-composition.test.mjs \
  v2/modules/daemon/tests/server-pending-close.test.mjs
```

Result: `64` tests, `64` passed, `0` failed, exit `0`.
Raw receipts: `daemon-tests.log`.

Isolated raw-input regression:

```text
node --test --test-concurrency=1 v2/modules/daemon/tests/terminal-input-raw.test.mjs
```

Result: `5` tests, `5` passed, `0` failed, exit `0`.
Raw receipt: `terminal-input-raw-isolated.log`.
