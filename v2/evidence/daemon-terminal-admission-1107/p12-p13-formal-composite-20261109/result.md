# P1-2 Formal Composite Retest

## Baseline

- Worktree: `/Volumes/Intel/playground/zterm/worktrees/terminal-admission-composition-p1-merge-20261109`
- HEAD: `b66093736a0664c0069c3d1fe332552a2eac3512`
- Branch: `terminal-admission-composition-p1-merge-20261109`
- The HEAD contains the P1-1 merge and the `b6609373` test-only stabilization for wrapped raw-input capture.
- This run did not push, merge to main, open a PR, publish, restart a shared daemon, or perform tmux lifecycle actions.

## Real Entry Probe

The probes use the supported `startDaemon` entry and the running isolated V1 fixture
`isolated-v1-46546-mw89j6nf`:

- V1 daemon PID: `46560`
- V1 port: `56129`
- Catalog stable ID: `tmux:v1:%7B%22backend%22%3A%22tmux%22%2C%22serverPid%22%3A%2246550%22%2C%22sessionId%22%3A%22%240%22%2C%22createdAt%22%3A1794168385%7D`
- P1-2 command: `node v2/evidence/daemon-terminal-admission-1107/p12-p13-formal-composite-20261109/p12-formal.mjs`
- P1-3 command: `node v2/evidence/daemon-terminal-admission-1107/p12-p13-formal-composite-20261109/p13-formal.mjs`
- Probe exit code: `0` for both commands

## P1-2 Positive Result

- Stream ready event observed: `true`
- Committed initial frame observed: `true`
- Committed output frame observed: `true`
- Input last byte: `0d` (real CR)
- Unique marker: `P12OUT_p12mw8mg7oycegjbd_d9c58004`
- Token present in input text: `false`
- Unique output confirmed in the stream frame: `true`
- Unique output confirmed by tmux capture: `true`
- Terminal side effects after positive flow: `connects=1`, `channelOpens=1`, `inputWrites=1`

Raw receipts are in `p12-result.json`, `p12-run.log`, `p12-initial-committed-frame.json`,
`p12-unique-output-frame.json`, `p12-unique-output.txt`, `p12-input-response.json`,
`p12-sse-events.json`, and `p12-side-effects.json`.

## P1-3 Revocation Result

- Positive stream/input before revocation: `200/200`
- After accounts grant revoke, stream/input: `403/403`
  - Error code: `WORKSPACE_AUTHORIZATION_REQUIRED`
  - Owning module: `accounts`
- After machine revoke, stream/input: `403/403`
  - Error code: `MACHINE_REVOKED`
  - Owning module: `accounts`
- Live terminal transport stayed connected through both revocations: `true`
- Side effects after each revocation stayed unchanged: `connects=1`, `channelOpens=1`, `inputWrites=1`

Raw receipts are in `p13-result.json`, `p13-run.log`, `p13-grant-revoked-*.json`,
`p13-machine-revoked-*.json`, and `p13-live-link-after-*.json`.

## Affected Tests

Command:

```text
node --test --test-concurrency=1 \
  v2/modules/daemon/tests/machine-terminal-consumer.test.mjs \
  v2/modules/daemon/tests/startup-config.test.mjs \
  v2/modules/daemon/tests/terminal-admission.test.mjs \
  v2/modules/daemon/tests/terminal-admission-fail-closed.test.mjs
```

Result: `39` tests, `39` passed, `0` failed, exit `0`.

The raw-input regression test was also run in isolation and passed:
`terminal-admission-raw-input-isolated-20261109.log` (`1/1` passed).

## Known Finding

The host producer path still returns `BINDING_HOST_UNAVAILABLE` with
`owningModule=members`; its host-supplied stable ID remains null and does not equal the
catalog stable ID. This is the previously reported host-producer stable-ID gap and does
not block the catalog positive path or the two authorization revocations above.

## Conclusion

- P1-2 formal composite positive retest: PASS
- P1-3 grant and machine revocation retest: PASS
- Formal review is ready for Mia using this evidence directory.
- The tasks remain `accepted`; integration and close are intentionally not performed.
