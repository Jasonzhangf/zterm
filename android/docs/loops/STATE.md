# Loop State

```yaml
loop_id: zterm.daily-triage
pattern: daily-triage
mode: L1
kill_switch: inactive
owner_feature: project.loop_governance
last_run_id: 2026-07-04T13:10:22Z
last_outcome: report-only
active_item: null
actions_taken_this_period: 0
escalations_this_period: 3
```

## Notes

- `mode: L1` means report-only.
- `kill_switch: active` means the loop must no-op.
- This file is state, not a report. Append run history to `loop-run-log.md`.
