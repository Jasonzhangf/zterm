# Daemon session agent status probe test design

Owner: `daemon.session_catalog`.

White-box contract tests cover exact session-targeted passive observation:
foreground process, process-group presence, captured output, and OSC signals.
The tests explicitly reject semantic inference of agent `running`/`idle`.
Negative cases cover vanished sessions and tmux command failure as explicit
observation gaps/errors.

Black-box fixture tests use an isolated tmux server/session and prove that the
catalog enumerates only actual sessions and that pane title, cwd, root, Codex
task, Herdr identity, and unrelated sessions cannot create agent identity or
status. The drawer remains presence-only.

Required gates: `daemon-session-catalog-runtime.test.ts`,
`daemon-session-catalog-ownership.test.ts`, module/import/edge registry gates,
type-check, and the canonical Android prebuild. Installation/restart/live tmux
fixture evidence is required before review or delivery.
