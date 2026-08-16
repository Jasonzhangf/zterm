# Loop Budget

## L1 Daily Triage Budget

```yaml
loop_id: zterm.daily-triage
mode: L1
max_elapsed_minutes: 20
max_report_items: 10
max_git_diff_files_to_summarize: 30
max_memory_search_results: 5
max_test_commands: 2
max_actions_taken: 0
```

## Budget Rules

- If a cap is hit, stop and report `escalated`.
- Do not continue by weakening scope or hiding skipped checks.
- Raw evidence stays under ignored evidence paths when needed; memory gets only summaries.
