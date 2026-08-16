# Loop Constraints

## Current Level

`daily-triage` is initialized at `L1 report-only`.

## Allowed In L1

- Read project governance docs, maps, memory, task files, and git status.
- Run parseability/static truth gates listed in `loop-manifest.json`.
- Produce a report.
- Append exactly one run-log entry per run.

## Denied In L1

- Product code edits.
- Config edits outside `android/docs/loops/**` unless the task is explicitly to change loop governance.
- Starting, stopping, restarting, or installing daemons.
- Running Android build, APK release, or service install flows only for loop triage.
- Staging files, committing, pushing, merging, or opening releases.
- Deleting, moving, or rewriting evidence directories.
- Broad process-kill commands.
- Any fallback, silent success, weakened assertion, or disabled test.

## L2 Assisted Preconditions

Before any L2 action:

- one item only;
- one unique owner path;
- feature registry, function map, feature gates, and mainline call map all bind the item;
- maker and checker are separate;
- required gates are known and runnable;
- max 3 attempts;
- no auto-merge.

If a verifier cannot run required gates, the result is `ESCALATE`.

## Denylist For All Modes Without Explicit Jason Approval

- auth, secret, payment, production infra, migration, or publish changes;
- destructive cleanup outside the named owner path;
- rollback or deletion of unrelated dirty worktree files;
- daemon/service restart on a user's active machine;
- auto-fixing issues found by report-only triage.
