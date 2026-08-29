# Daemon session agent status probe

Status: design locked for `daemon.session_agent_status_probe`.

## Scope and owner

`daemon.session_catalog` remains the only owner. Its session catalog is
enumerated from actual daemon-visible tmux sessions. The drawer and all client
state are non-owners: they do not identify agents, cache status, or infer
availability from terminal output.

## Passive observation contract

The agent is a black box. The daemon observes only the exact catalog session's
foreground process label, process-group presence, recent captured output, and
visible OSC title/progress escape sequences. These are observations, not agent
identity or semantic completion signals. Pane title, cwd, root, Codex task,
Herdr identity, and any agent cooperation are excluded.

## Proof and lifecycle

The daemon samples observations when building the catalog. Process exit,
session disappearance, output sequence changes, and OSC signals are reported
as facts. They do not prove agent `running` or `idle`; no semantic status is
fabricated. A failed tmux read is explicit error and is not cached as success.

The typed `observation` field is carried only in the daemon's
backend-qualified `sessions` control projection. It is not terminal body,
metadata, mirror, or client agent state. The drawer remains a presence-only
consumer and must not interpret these facts as agent status.

## Verification

Positive tests prove exact-session process/output/OSC observations. Negative
tests prove session disappearance and tmux read errors remain explicit gaps;
terminal output and unrelated sessions cannot create agent identity or
semantic status. The probe has no client or mirror imports.
