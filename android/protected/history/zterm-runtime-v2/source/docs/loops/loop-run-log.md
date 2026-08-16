# Loop Run Log

Append one JSON object per run. Keep this file append-only.

Expected shape:

```json
{
  "run_id": "ISO8601",
  "pattern": "daily-triage",
  "mode": "L1",
  "items_found": 0,
  "actions_taken": 0,
  "escalations": 0,
  "tests": ["command -> result"],
  "outcome": "no-op"
}
```

Initial state: no loop run has been executed yet.

{
  "run_id": "2026-07-04T13:10:22Z",
  "pattern": "daily-triage",
  "mode": "L1",
  "items_found": 3,
  "actions_taken": 0,
  "escalations": 3,
  "tests": [
    "rtk pnpm --dir android run test:feature-registry -- --reporter dot -> PASS (4 files / 30 tests)",
    "rtk git diff --check -> PASS"
  ],
  "outcome": "report-only",
  "items": [
    {
      "feature_id": "project.loop_governance",
      "owner_path": "mac/evidence/2026-07-04-*",
      "allowed_path": "report-only inspection; no cleanup owner registered",
      "forbidden_path_check": "project.loop_governance forbids ../mac/evidence/ writes; no stage/delete/cleanup performed",
      "required_gate": "owner binding and explicit evidence retention decision before any cleanup",
      "mainline_call_id": "binding pending",
      "status": "report-only",
      "summary": "Worktree has untracked mac/evidence/2026-07-04-* directories from prior Mac smoke evidence."
    },
    {
      "feature_id": "project.loop_governance",
      "owner_path": "android/task.md",
      "allowed_path": "report-only inspection; task cleanup owner binding pending",
      "forbidden_path_check": "no task rewrite performed in L1",
      "required_gate": "task hygiene owner plus test:feature-registry before any governance cleanup",
      "mainline_call_id": "binding pending",
      "status": "report-only",
      "summary": "task.md contains old active slices, embedded tool transcript markers, and stale pending entries."
    },
    {
      "feature_id": "project.loop_governance",
      "owner_path": "android/CACHE.md",
      "allowed_path": "report-only inspection; cache cleanup owner binding pending",
      "forbidden_path_check": "no cache rewrite performed in L1",
      "required_gate": "cache hygiene owner plus test:feature-registry before any governance cleanup",
      "mainline_call_id": "binding pending",
      "status": "report-only",
      "summary": "CACHE.md still carries older remaining-work and commit/push notes that do not match the current clean Android governance baseline."
    }
  ]
}
