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
