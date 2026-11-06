# Acceptance

Task: zterm-v2-accounts-relay-wiring-1103-r1
Branch: zterm-v2-accounts-relay-wiring-1103-r1-main
Base: LayerFS main@3280b391b35cb6ff2ba9b0eaffe97ec972df8c4fe4e339177b5054358695cdd455
Merged from: zterm-v2-accounts-relay-wiring-1103-r1 head 126289a1

## Result

Module suite: 56 passed / 0 failed on the merged candidate (see
green-mainmerge-56.txt; the pre-merge 56/56 receipt is green-rework-56.txt).
Integration runs against a real isolated V1 relay process
(`android/src/traversal-relay/server.ts`) over loopback HTTP with a temp store.

## Checklist

- [x] red-before-green: base + new tests = 38 pass / 12 fail (`red-run.txt`)
- [x] logout delegating to `POST /api/auth/logout`; afterwards the bearer is
      401 from `/me` and from machine calls
- [x] enrollment uses `POST /api/machines/enroll/challenge|verify`
- [x] possession uses `POST /api/machines/possession/challenge|verify`
- [x] owner-only revoke uses `POST /api/machines/:machineId/revoke`
- [x] repeated same-proof enroll is idempotent (same machineId)
- [x] same deviceId with a different proof maps to 409 MACHINE_DEVICE_CONFLICT
- [x] cross-account proof reuse maps to 409 MACHINE_ALREADY_OWNED
- [x] wrong possession proof maps to 403 POSSESSION_INVALID
- [x] non-owner revoke maps to 403 MACHINE_NOT_OWNED
- [x] post-revoke possession maps to 403 MACHINE_REVOKED
- [x] missing machine maps to 404 MACHINE_NOT_FOUND
- [x] canonical 409/403/404 codes are surfaced with upstreamStatus / upstreamCode
- [x] unreadable 403 is RELAY_PROTOCOL_ERROR, not a fake revoked session
- [x] V1 relay remains the single account/session/machine authority; no second
      account/directory/machine store was created
- [x] no edit outside `v2/modules/accounts/**` and
      `v2/evidence/zterm-v2-accounts-relay-wiring-1103-r1/**`
- [x] no push, PR, merge, global install, shared daemon restart, or tmux
      lifecycle action

## Rework checklist

- [x] `MachineRef.machineId` is the relay canonical ID; legacy device ID is an
      explicit `legacyDeviceId` compatibility field
- [x] `listAuthorizedMachines` reads relay canonical machine summaries
- [x] enrollment no longer reads or blocks on the legacy directory
- [x] unknown valid-JSON 403s are `RELAY_PERMISSION_DENIED` and keep
      `upstreamStatus` / `upstreamCode` / `upstreamMessage`
- [x] explicit `session_revoked` remains `SESSION_REVOKED`
- [x] real relay `GET /api/machines` is present on merged LayerFS main and the
      non-empty host-directory -> enroll -> canonical list -> revoke -> inactive
      list case passes (see `green-mainmerge.txt`; the previous 404 route gap is
      preserved in `canonical-list-gap.txt`)

## Open items

Product combination with connections/organization/members/routing remains with
the integration owner (Jenny). This is module-level evidence only.
