# Daemon session agent status probe

Status: design locked for `daemon.session_agent_status_probe`.

## Scope and owner

`daemon.session_catalog` remains the only owner. Its session catalog is
enumerated from actual daemon-visible tmux sessions. The drawer and all client
state are non-owners: they do not identify agents, cache status, or infer
availability from terminal output.

## Explicit identification contract

An agent is identified only when the session registers all three tmux
user-options below on its exact session target:

- `@zterm_agent_name`: non-empty stable occupant alias.
- `@zterm_agent_state`: exactly `running` or `idle`.
- `@zterm_agent_heartbeat_ms`: decimal Unix milliseconds.

The daemon reads these options with `show-options`; it never uses pane title,
cwd, root, process name, Herdr identity, Codex task identity, or terminal
bytes as an identity source. The session name is the catalog identity; the
agent name is only an explicitly registered occupant identity.

## Proof and lifecycle

The daemon samples registration on catalog probe. A fresh heartbeat proves
only that the registered agent reported its declared state; it does not prove
work completion. `running` and `idle` are accepted only with a valid state and
heartbeat no older than 30 seconds. Missing registration or an agent session
that disappeared is `unknown`. Malformed/conflicting options are `error`.
An otherwise valid registration whose heartbeat exceeds 30 seconds is
`unknown` with reason `stale_heartbeat`; the daemon never converts stale into
idle or running. A tmux read failure is `error` and is not cached as success.

There is no wire field in this slice: no current drawer consumer contract
requires it, and adding a shared payload field would broaden the control
surface without an owner. The fact remains daemon-owned and testable at the
probe boundary; a future wire projection must be a separately mapped control
contract.

## Verification

Positive tests prove exact-session option reads and fresh `running`/`idle`
registration. Negative tests prove absent identity, invalid state/timestamp,
stale heartbeat, session disappearance, and tmux read errors resolve to
explicit `unknown`/`error`; terminal output and unrelated sessions cannot
affect the result. The probe has no client or mirror imports.
