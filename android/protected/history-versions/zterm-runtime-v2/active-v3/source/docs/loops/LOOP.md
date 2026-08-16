# zterm Project Loop

## Purpose

Initialize a governed project triage loop for zterm without enabling unattended action.

The first real loop is `daily-triage` in `L1 report-only` mode. It reads project truth, checks for stale state or map drift, writes a report/run-log entry, and stops. It must not edit product code, start or stop daemons, stage files, commit, push, merge, or run broad destructive commands.

## Owner

- `feature_id`: `project.loop_governance`
- Human owner: Jason
- Agent owner surface: `android/docs/loops/**`, `android/src/lib/loop-governance-truth.test.ts`, and the registered governance maps.

## Current Mode

- Mode: `L1`
- Pattern: `daily-triage`
- Cadence: manual or scheduled by an external runner only after Jason explicitly enables it
- Action level: report-only

## Required Start-Of-Run Order

1. Search MemoryPalace for project loop incidents, active constraints, and current baseline.
2. Read:
   - `android/docs/loops/LOOP.md`
   - `android/docs/loops/STATE.md`
   - `android/docs/loops/loop-constraints.md`
   - `android/docs/loops/loop-budget.md`
   - recent entries in `android/docs/loops/loop-run-log.md`
3. Confirm `kill_switch` is `inactive`.
4. Confirm token/time/action spend is below budget.
5. Read the canonical project maps:
   - `android/docs/feature-registry.json`
   - `android/docs/function-map.md`
   - `android/docs/feature-gates.md`
   - `android/docs/wiki/mainline-call-map.json`
6. Exit early and log no-op if there is no actionable finding.

## L1 Report-Only Scope

Allowed checks:

- `git status --short` and diff summaries.
- Parseability and lockstep of feature registry, function map, feature gates, loop manifest, and mainline call map.
- `android/task.md`, `android/CACHE.md`, `android/note.md`, and `android/MEMORY.md` for stale or unresolved items.
- Recent ignored evidence summaries only when a specific loop report needs them.
- Required gate lookup for each finding.

Required output:

- A concise report.
- One append-only run-log entry.
- Optional `note.md` summary if a finding is useful but not yet durable truth.

## Required Binding For Every Finding

Every non-no-op finding must include:

- `feature_id`
- unique owner path
- allowed path
- forbidden path check
- required gate
- `mainline_call_id` when the finding touches a mainline lifecycle
- explicit status: `report-only`, `escalated`, or `binding pending`

`binding pending` is allowed only in L1 reports. It blocks L2 action until the map is completed.

## Kill Switch

The kill switch lives in `android/docs/loops/STATE.md`.

When `kill_switch: active`, the loop must:

- perform no project inspection beyond reading the loop files required to notice the switch;
- take no action;
- append a no-op run-log entry only if a human explicitly requested a run status.

## Human Gates

L2 and L3 are not enabled by this initialization.

L2 assisted requires all of the following:

- multiple L1 runs with low false-positive rate;
- every proposed item has a unique `feature_id`, owner, required gates, and adjacent mainline call binding;
- maker/checker roles are explicit;
- max attempts and escalation path are set;
- Jason explicitly approves the upgrade.

L3 unattended additionally requires real run history, conflict detection, verifier evidence, budget enforcement, and an explicit enable decision from Jason.
