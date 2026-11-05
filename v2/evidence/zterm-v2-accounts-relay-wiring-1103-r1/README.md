# accounts relay wiring evidence

Task: zterm-v2-accounts-relay-wiring-1103-r1
Owner: Grace. Reviewer: David. Integrator: Jenny.

## Proof

The only authority is the real V1 relay process spawned from
`android/src/traversal-relay/server.ts` with an isolated temp data directory
and a loopback port. The integration test under
`v2/modules/accounts/tests/integration/accounts-flow.test.ts` starts that real
process and drives `AuthService` and `MachineService` through the actual HTTP
endpoints. It does not use an in-process fixture for the relay.

Commands:

```sh
cd /workspaces/<id>/v2/modules/accounts
NODE_PATH=/workspaces/<id>/android/node_modules \
  node --test tests/contract/*.test.ts tests/integration/*.test.ts
```

Current result: 56 passed / 0 failed (2026-11-04 merged head 12a600cd).
The real canonical-list black-box also passes on the candidate merged with
LayerFS main@3280b391b35c (see green-mainmerge.txt / green-mainmerge-56.txt).

## Real chain covered

1. register -> login -> /me revalidation.
2. enroll challenge/verify on the same device proof twice returns the same
   canonical machine.
3. same deviceId with a different proof returns 409 machine_device_conflict.
4. the same proof from another account returns 409 machine_already_owned.
5. possession challenge/verify rejects a wrong device proof with 403
   possession_invalid.
6. possession challenge/verify succeeds for the owner.
7. a non-owner revoke returns 403 machine_not_owned.
8. owner revoke returns machineId with status revoked.
9. possession after owner revoke returns 403 machine_revoked.
10. possession for a missing machine returns 404 machine_not_found.
11. logout revokes the bearer at the relay; /me and machine calls using that
    bearer now return 401 AUTHENTICATION_REQUIRED.

## Rework coverage

- `MachineService.listAuthorizedMachines` consumes canonical relay machine
  summaries. It projects `machineId`, `ownerAccountId`, `displayName`, status,
  and `createdAt` from the relay. A legacy device ID is optional and stays in
  `legacyDeviceId`.
- Enrollment no longer reads the legacy directory before calling the relay.
- Unknown valid-JSON 403 responses are `RELAY_PERMISSION_DENIED` with status and
  upstream details preserved. Only explicit `session_revoked` is mapped to
  `SESSION_REVOKED`.
- The current rework suite is 56/56 green. See `green-rework-56.txt`.

## Canonical machine list (merged LayerFS main)

The V1 relay public `GET /api/machines` route is present on LayerFS main
(`android/src/traversal-relay/server.ts` line 1004). The candidate was merged
with main and the real isolated relay black-box now passes:

host-directory-non-empty -> enroll -> canonical active list -> revoke ->
inactive list (status revoked). See `green-mainmerge.txt`.

The prior 404 failure evidence remains under `canonical-list-gap.txt`; that
was the relay route gap before Jenny restored it. The V2 adapter still does not
create a fallback machine source.

## Boundary

No push, PR, merge, global install, shared daemon restart, or tmux lifecycle
action. No edit outside `v2/modules/accounts/**` and
`v2/evidence/zterm-v2-accounts-relay-wiring-1103-r1/**`.
