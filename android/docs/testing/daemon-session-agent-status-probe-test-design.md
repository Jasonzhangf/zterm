# Daemon session agent status probe test design

Owner: `daemon.session_catalog`.

White-box contract tests cover exact session-targeted passive observation and
daemon-owned status classification: foreground process/job/group, manifest
match, captured output, OSC signals, and lifecycle stabilization. The tests
reject output-only/no-output-only heuristics while proving evidence-backed
`running`/`idle`, plus `unknown` for insufficient evidence and `error` for
failed reads. Negative cases cover vanished sessions and tmux command failure
as explicit observation gaps/errors.

Black-box fixture tests use an isolated tmux server/session and prove that the
catalog enumerates only actual sessions and that pane title, cwd, root, Codex
task, Herdr identity, and unrelated sessions cannot create agent identity or
status. Phase 1 drawer consumption is zero. Phase 2 is display-only and cannot
reclassify, maintain, or gate availability from daemon status.

Required gates: `daemon-session-catalog-runtime.test.ts`,
`daemon-session-catalog-ownership.test.ts`, module/import/edge registry gates,
type-check, and the canonical Android prebuild. Installation/restart/live tmux
fixture evidence is required before review or delivery. Online evidence must
come from the daemon's actual `sessions` control frame and include positive
status plus unknown/error cases.
