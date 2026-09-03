# Git main protection test design

Feature: `git.main_protection`

The project admission gate is the tracked hook pair plus the idempotent setup
script. Each clean owner worktree runs:

```bash
./scripts/setup/enable-local-protection.sh
appsdk verify-git-main-protection .
```

The verifier checks hook presence, executable permissions, setup wiring, and
the worktree's `core.hooksPath`. CI uses the same command; this control-plane
gate does not claim code review, build, installation, restart, or runtime
behavior.
