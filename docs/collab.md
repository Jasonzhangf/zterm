# collab workflow

This project uses the local `collab` daemon for multi-agent coordination.
The binary lives in `~/code/collab`; the installed command is
`~/.cargo/bin/collab`.

The daemon is detached. Normal commands may start it when no explicit `DOWN`
marker exists. `collab init` creates the local
`.agent-collab/server` skeleton, so old projects need no manual repair. Use
`collab down` only for an explicit stop; use `collab up` to clear that stop and
start it again. Never start a second daemon.
Existing projects migrate through `collab migrate inspect`, `plan`, `apply`,
controlled daemon upgrade/restart, identity rebind, and `verify`;
deleting `.agent-collab`, editing JSON state, clearing mailboxes, copying
tokens, mixed runtime writes, and guessing pane identity are deprecated.

## Runtime boundary

- Every peer registration must come from a live tmux pane.
- tmux is the only live notification channel and remains wake-only.
- Server state, journal, and mailbox are durable truth; a failed wake cannot
  roll back state or fabricate success.
- The runtime is part of the peer identity boundary, not a task preference.

## Roles

- Every registered identity is an equal `peer`; there is no permanent master.
- Each peer self-registers one task and owns its full worktree, test,
  integration, main verification, push, cleanup, and resource lifecycle.
- Task owner, resource holder, integration lease, and daemon operator are
  scoped capabilities, never durable identity roles.
- Peers send no normal progress reports. P2P communication is limited to
  durable resource occupancy and release coordination.

## Task lifecycle

```
working -> verifying -> reviewed -> delivered
        -> owner sync/verify/integrate -> merged -> close/cleanup -> closed
        -> rework -> working
blocked -> bounded waiting -> resource release/timeout -> owner recheck
```

Task records use a fixed shape:
`id / owner / feature_id / worktree_path / branch / base_commit / priority /
 status`. Normal statuses are `working`, `blocked`, `waiting`, `verifying`,
 `reviewed`, `delivered`, `rework`, `merged`, `closed`, and `cancelled`.

## Common commands

```sh
collab up                         # clear explicit down and start daemon
collab down                       # explicit stop; disables auto-restart
collab who                        # registered peers + local state projection
collab task status [task-id]      # durable task registry
collab notify methods             # discover opt-in notification methods
collab notify subscribe --event direct-message --ttl-seconds 600
collab notify status
collab context                    # read-only authoritative state snapshot
collab task register <id> --feature <feature-id> --worktree <path> \
  --branch <branch> --base-commit <sha> --priority p2
collab task wait <id> --for <blocking-task>
collab task deliver <id> --evidence "commit=<sha>; gates=pass" --worktree <path>
collab task block <id> --next "blocked: <evidence and next condition>"
collab task update <id> --status merged
collab task close <id>            # owner; verifies merged/clean, releases claim
```

Peers never share worktrees. Each task owner starts from latest main in one
declared clean `./playground/` worktree, implements and tests, commits the exact
change set, syncs latest main again, verifies the candidate, acquires a short
integration lease, merges the exact commit to main, verifies and pushes main,
then closes the task to remove only its clean merged worktree/branch. Delivery
is an owner-local durable milestone and sends no peer notification. `/goal`
delegation and interactive task recognition are intentionally deferred.

## Message handling

On a notification, query durable state before acting. `collab send`
accepts only `RESOURCE_OCCUPIED` and `RESOURCE_RELEASED` coordination. Never
type peer messages with tmux. The daemon may send only a short notification id
after the receiving Agent registers a finite one-shot subscription.

`collab inbox` and `collab msg <id>` query the durable local mailbox after a
tmux pane disappears; mailbox state remains authoritative.

## Notifications and waits

There is no periodic continuation. Agent-owned subscriptions are exact-event,
exact-subject, finite, and one-shot. No registration, absent, unknown, working,
expired, cancelled, consumed, or three-attempt-exhausted state produces tmux
input. Every wait stores waiter, blocking task owner, reason, deadline, resume
events, and P2P escalation. Timeout changes state without unsolicited messages;
resource release notifies only an exact active subscriber.
