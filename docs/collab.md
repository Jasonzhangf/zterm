# zterm Collab workflow

This project uses the stable v1 Collab daemon. Coordination is project-local:
all agents share one detached daemon and communicate through its Unix socket and
verified terminal runtime.

The runtime is fixed by the first registration: either all workers use tmux or
all workers use Herdr. A tmux worker cannot join a Herdr project, and a Herdr
worker cannot join a tmux project. Registration and messages across runtimes
are rejected. Herdr and tmux are alternatives, not a layered stack.

## Startup

From the project root, each agent runs:

```sh
collab init
```

`collab init` creates or reuses `.agent-collab`, starts the detached daemon,
registers the current tmux or Herdr pane, and returns the stable worker
identity, runtime, and role. The first successful registration is the project
master; later workers cannot replace it. Do not run `collab-v2`, use App Server,
or edit state files.

## Identity truth

Herdr identity is derived only from the live runtime pair:

- `HERDR_SOCKET_PATH` (the Herdr session namespace)
- `HERDR_PANE_ID` (the pane inside that session)

The resulting worker id is:

```text
pane-herdr-<sanitized-session-socket>-<pane-id>
```

Examples:

```text
pane-herdr-_Users_fanzhang_.config_herdr_sessions_zterm-5_herdr.sock-w1_p1
pane-herdr-_Users_fanzhang_.config_herdr_sessions_zterm-6_herdr.sock-w1_p1
```

The following values are NOT identity credentials and must never be used alone:
`HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `terminal_id`, cwd,
pane title, or a manually supplied worker id. A pane id may be reused by a new
Herdr session; the session socket prevents that collision. The same Herdr
session and pane must reuse the same identity; the same pane id in a different
Herdr session must produce a different identity. A project is keyed by its
working-tree cwd, so multiple Herdr sessions in the same cwd share one Collab
project, one master, and one task board.

Every worker must verify its identity after running `collab init`:

```sh
printf 'HERDR_ENV=%s\nHERDR_SOCKET_PATH=%s\nHERDR_PANE_ID=%s\n' \
  "$HERDR_ENV" "$HERDR_SOCKET_PATH" "$HERDR_PANE_ID"
herdr session list
collab --version
collab whoami
collab role
collab who
collab master
collab task status
```

If `collab whoami` reports an identity that does not match
`HERDR_SOCKET_PATH + HERDR_PANE_ID`, or reports a legacy
`pane-herdr-w1_p1`-style or `terminal_id`-based identity, stop and report the
discrepancy to the current master. Do not delete `.agent-collab`, the journal,
tasks, mailbox, or start a second daemon. Do not hand-edit the identity journal
or registration files. A stale registration may be removed only by the current
master, and only when it has no active claim.

After init:

```sh
collab role
collab who
collab task status
```

## Communication

Use the daemon mailbox and runtime input path:

```sh
collab send --to <worker> --type notify "message"
collab recv --timeout 600
collab inbox
collab ack <message-id>
collab msg <message-id>
```

The daemon persists each message before waking the target pane. For tmux it
uses literal `tmux send-keys` plus Enter; for Herdr it uses the registered
Herdr socket with `pane send-text` plus Enter. A successful input submission is
not an acknowledgement: the recipient must read the inbox and acknowledge the
message. `recv` is the durable receive path when a pane is busy or a prompt was
missed. Keep communication sparse: notify for facts, request for a decision,
reply only with substantive evidence.

## Task board

Master creates tasks; workers claim available tasks:

```sh
collab task register <task-id> --feature <feature-id> \
  --worktree ./playground/<task-id>-<run-id> \
  --branch codex/<task-id> --base-commit <sha> \
  --priority p1 --next "implement; verify; deliver"

collab task claim <task-id>
collab task update <task-id> --status verifying --next "run gates"
collab task deliver <task-id> --evidence "commit=<sha>; tests=pass"
collab task update <task-id> --status merged
collab task close <task-id>

# master migration / stale registration cleanup
collab transfer-master <worker-id>
collab remove-worker <worker-id>
```

Only the master registers, merges, closes, cancels, and dispatches tasks.
Workers claim available tasks, work in their declared playground worktree, and
deliver evidence. Claims are daemon-serialized; a worker may hold one active
task. The task record is the only legacy data retained during migration.

## Migration boundary

The old `.agent-collab-v2` control plane and App Server records are removed.
Only task scopes required by the current project may be re-created on the v1
board after cross-checking the repository and current master direction. Do not
carry over old identities, panels, tokens, mailboxes, messages, heartbeats,
App Server PIDs, or stale ownership.

After migration, verify:

```sh
find . -maxdepth 1 -type d -name '.agent-collab-v2' -print
collab status
collab who
collab task status
```

The first command must print nothing. All active workers must re-register with
the v1 daemon, and old tasks in `working` state must be re-claimed explicitly.
