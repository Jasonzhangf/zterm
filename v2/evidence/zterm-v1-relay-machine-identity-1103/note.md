# V1 relay machine identity implementation note

## Changed files

- `android/src/traversal-relay/store.ts`
  - Adds session token revocation and rejects revoked tokens during
    authentication.
  - Adds canonical machine records, process-local enrollment and possession
    challenges, typed error handling, and owner-only revocation.
  - Persists only a SHA-256 hash of device proof material.
  - Enforces canonical proof ownership across accounts.
- `android/src/traversal-relay/server.ts`
  - Adds logout, enrollment, possession, and machine revocation HTTP routes.
  - Validates required and unknown request fields.
  - Maps machine identity failures to typed HTTP errors.
- `android/src/traversal-relay/machine-identity.test.ts`
  - Adds isolated real-relay tests for logout, enrollment, possession,
    cross-account proof reuse, owner revocation, and revoked-machine rejection.
- `v2/evidence/zterm-v1-relay-machine-identity-1103/**`
  - Adds the real two-account self-check and raw gate transcripts.

## Removed or retained

No product behavior was deleted. The existing legacy device record remains
account-scoped by `(userId, deviceId)`. No global `deviceId` uniqueness was
added, and no second account store was created.

## DAG and authority

Affected object flow:

`login token -> logout revocation`

and

`login token -> machine challenge -> verify -> canonical machine -> possession/revoke`

This is a missing-edge completion in the existing V1 relay graph. The unique
writer is `android/src/traversal-relay/{server,store}.ts`, with dedicated tests
and evidence. No DAG topology file was edited because the task's writable scope
excludes DAG files.

Legacy observer evidence for the unchanged account-scoped behavior:
`/Volumes/Intel/playground/zterm/.worker-runs/zterm-v1-relay-owner-verify-1103/observer-2/result.md`.
It confirms that two accounts may retain the same legacy `deviceId`; this task
only adds canonical machine identity.

## Verification

- Targeted real-relay test: 3 passed.
- Full traversal relay suite: 70 passed across 8 files.
- Type check: exit 0; no source-JS pollution.
- Real isolated two-account self-check: passed with the expected positive and
  negative statuses.
- No push, PR, merge, global install, daemon restart, or tmux lifecycle action.

## Remaining risks

- Enrollment and possession challenges are intentionally in memory. A relay
  restart invalidates pending challenges; clients must request a new challenge.
- Canonical uniqueness is based on stable device proof material. If a client
  rotates or loses that proof, the server cannot infer physical identity from
  legacy `deviceId` alone.
- The implementation is a source candidate and evidence bundle. V2 accounts
  integration and production deployment remain outside this task.
