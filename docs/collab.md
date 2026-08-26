# zterm collab workflow

This project uses the local `collab` daemon for multi-agent coordination. The
source binary lives in `~/code/collab`; the installed command is
`~/.local/bin/collab`.

## Truth sources

- Global skill: `~/.agents/skills/collab/SKILL.md`
- Project coordination state: `.agent-collab/`
- Phase manifest: `docs/architecture/zterm-cordis-v2-phase-manifest.json`
- Rebuild plan: `docs/goals/zterm-cordis-v2-rebuild-plan.md`

## Roles

- First registered pane is `master`; every later pane is `worker`.
- Master creates tasks, reviews `delivered` work, merges, closes tasks, and
  cleans declared worktrees after merge.
- Workers claim `available` tasks and work independently. They do not request
  claim approval and do not register tasks.
- Check identity with `collab role`, `collab who`, or `collab master`.

## Task lifecycle

```
available -> working -> verifying -> reviewed -> delivered
          -> master merge -> close/cleanup -> closed
          -> rework -> working
```

Task records use a fixed shape:
`id / owner / feature_id / worktree_path / branch / base_commit / priority /
status`. Valid statuses are `available`, `working`, `verifying`, `reviewed`,
`delivered`, `rework`, `merged`, `closed`, and `cancelled`.

## Common commands

```sh
collab config                     # show .agent-collab/collab.json
collab config --heartbeat-minutes 45
collab who                        # workers + active task status
collab task status [task-id]      # board or one task
collab task register <id> --feature <feature-id> --worktree <path> \
  --branch <branch> --base-commit <sha> --priority p2 --next "<next step>"
collab task claim <id>            # worker self-service
collab task deliver <id> --evidence "commit=<sha>; gates=pass"
collab task update <id> --status merged
collab task dispatch             # master: assign available tasks to idle workers
collab task close <id>            # master; verifies merged/clean then cleans
```

## Post-merge dispatch

`collab task dispatch` is the master's automatic post-merge dispatch point.
Run it after registering the decomposed next-milestone tasks. The daemon scans
the board in one state transaction:

1. `available` tasks are sorted by priority (`p0` first), then creation time.
2. Idle workers (no active `working/verifying/reviewed` claim) receive the
   highest-priority tasks as direct assignments. The task becomes `working`,
   the worker becomes owner, and a `TASK_ASSIGNED` mailbox message is sent
   with the fixed task contract and full tmux prompt.
3. If all workers are busy, remaining tasks stay `available`; no duplicate
   message is sent. Workers claim them from `collab task status`.
4. `collab task close` also calls the same dispatch automatically, so
   pre-registered tasks are assigned during cleanup.

Master's merge completion step is therefore:

```sh
# merge delivered branch
collab task close <task-id>       # cleanup + dispatch any pre-registered tasks
# immediately decompose and register the next milestone tasks
collab task register <task-id> --feature <feature-id> --worktree <path> \
  --branch codex/<task-id> --base-commit <sha> --priority p1 \
  --next "read docs/goals/<task-id>.md; create worktree; implement; verify; deliver"
collab task dispatch              # assign available tasks to idle workers
```

Task registration is the decomposition contract: every task must carry `id`,
`feature_id`, worktree path, branch, base commit, priority, and `--next`.
The `TASK_ASSIGNED` prompt includes the full task contract, so the assigned
worker can start without another approval message.

## Active claims

Only workers with an active claim receive heartbeats. `collab who` exposes
`active_task` and `active_status` for every worker, so master can dispatch to
idle workers without messaging busy ones.

## Project defaults

`.agent-collab/collab.json` currently defaults heartbeat interval to 45
minutes. Master updates it through `collab config`; the daemon reloads it
without a restart.
