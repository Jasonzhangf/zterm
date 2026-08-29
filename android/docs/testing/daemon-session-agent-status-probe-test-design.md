# Daemon session agent status probe test design

Owner: `daemon.session_catalog`.

White-box contract tests cover the exact tmux option names, session target,
state validation, heartbeat age, stale classification, and explicit error
handling. Positive cases use fresh explicit `running` and `idle` registrations.
Negative cases cover absent options (`unknown`), malformed/conflicting values
(`error`), stale heartbeat (`unknown` with `stale_heartbeat`), vanished session
(`unknown`), and tmux command failure (`error`).

Black-box fixture tests use an isolated tmux server/session and prove that the
catalog enumerates only actual sessions and that pane title, cwd, process
name, terminal body, and unrelated sessions cannot create agent identity or
status. No drawer/client test is added because the drawer is intentionally a
non-consumer in this slice; the ownership gate asserts that boundary.

Required gates: `daemon-session-catalog-runtime.test.ts`,
`daemon-session-catalog-ownership.test.ts`, module/import/edge registry gates,
type-check, and the canonical Android prebuild. Installation/restart/live tmux
fixture evidence is required before review or delivery.
