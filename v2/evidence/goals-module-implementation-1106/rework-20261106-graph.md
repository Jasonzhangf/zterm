# Goals null-name rework object flow

This rework only closes the `updateGoal` name boundary in the existing
single-writer goals object flow. No project-level DAG file is added.

```text
ARC.goal_update_request (actor token + workspaceId + goalId + optional name)
  -> G1 authenticate actor and require goals:write
  -> G2 allow workspace access
  -> G3 read current goal truth and locate goal in workspace
  -> G4 validate name semantics:
       undefined means not provided and keeps the current name;
       any provided name must be a non-empty string;
       null or an empty string rejects before store.update.
  -> G5 validate owner, parent, same-parent name, hierarchy, children, and references
  -> G6 atomically commit through the file store, or return read-only truth
  -> ARC.goal_update_result (goal / typed rejection / typed failure)
```

## Owners and terminals

| Node | Unique owner | Success | Rejection or failure |
| --- | --- | --- | --- |
| G1-G4 | goals application `updateGoal` | candidate update continues | `GOAL_FORBIDDEN`, validation, or `GOAL_INVALID_NAME` |
| G3 | goals file store `read` | current state | `STORE_PERSIST_FAILED` |
| G5 | goals application/domain invariants | accepted mutation continues | `GOAL_NOT_FOUND`, `GOAL_OWNER_INVALID`, `GOAL_PARENT_INVALID`, `GOAL_NAME_CONFLICT` |
| G6 | goals file store `update` | committed goal readback | `STORE_PERSIST_FAILED` |

The external entry is only `ARC.goal_update_request`. A name rejection happens
before `store.update`, so it has no business side effect. The original goal
remains available through `getGoal`, `listGoals`, and a later reopen of the same
file store.

`listGoals` reads names from persisted goals. With this boundary, every
explicitly written name is a non-empty string, so its `localeCompare` call no
longer receives `null`.

`unknown` does not apply here: the local synchronous file store has no
remote-write result that can be acknowledged but unresolved. A failed reference
read remains an explicit failure and cannot degrade into deletion.
