# V1 relay gaps to hand to Jenny (accounts first increment)

These are NOT implemented in `v2/modules/accounts` unless marked resolved. The
module delegates to the V1 public relay boundary and surfaces unresolved items
as typed gaps rather than faking a local account/session/machine authority.
Jenny owns finding the unique V1 relay owner and closing these gaps. These are
executor findings from the V1 public boundary; the relay owner must verify the
actual server capability.

## Relay owner determination (2026-11-03)

observer-2/result.md (task zterm-v1-relay-owner-verify-1103) determined the unique writer owner for the unresolved gaps:

- Remote session revocation, machine enrollment, possession challenge/verify, and server-enforced cross-account deviceId uniqueness all belong to the V1 relay server `android/src/traversal-relay/server.ts` and its store `android/src/traversal-relay/store.ts` (the V1 public boundary). These are NOT in `v2/modules/accounts`; this module cannot close them without the relay endpoint.
- V2 call sites: `src/adapters/v1-relay.ts` `enroll()` throws typed `UNSUPPORTED` 501 with `{accountId, deviceId}`; `src/application/auth-service.ts` `logout()` invalidates locally only (relay token is not remotely revoked) and `verifySession()` returns local `SESSION_REVOKED` 403; same-account deviceId uniqueness is asserted locally in `MachineService.enrollMachine` before the V1 gap.
- Remaining tests already cover each typed gap: `enrollMachine` -> `UNSUPPORTED` 501, local logout -> `SESSION_REVOKED` 403, duplicate same-account deviceId -> `MACHINE_ALREADY_ENROLLED` 409 (tests/contract/machine-service.test.ts; tests/integration/accounts-flow.test.ts).

## 1. Account self-service registration

**RESOLVED (R3):** The V1 relay server has `POST /api/auth/register`
(server.ts:919-928, store.ts:417-441). It returns `201 {"ok":true,"user":{"id",
"username","createdAt"}}` and does not issue a session token. The V2 adapter
now calls this endpoint and returns `{ accountId, loginName }` without
auto-login. Duplicate username maps to `ACCOUNT_EXISTS` 409; missing fields map
to `INVALID_REQUEST` 400.

  Evidence: observer-2/observation.md section A;
  relay-real-server-self-check.mjs against an isolated real relay server.

## 2. Remote session revocation

- V1 relay endpoint: none today; V1 logout is local CLI state only.
- V2 surface: `AuthService.logout` invalidates locally only; it does NOT claim
  remote token revocation. `verifySession` after logout returns local
  `SESSION_REVOKED` 403, but a stolen/expired token would still validate on the
  V1 server until its own expiry.
- Needed: a V1 relay revocation endpoint (or server-side session expiry) so V2
  logout can truly invalidate the relay token.

## 3. Machine enrollment and possession verification

- V1 relay endpoint: none today; directory only lists existing devices.
- V2 surface: `MachineService.enrollMachine` collects proof-of-possession
  MATERIAL (`deviceToken`, separate from account session) and performs a
  same-account deviceId uniqueness check, then delegates registration. A
  non-empty `deviceToken` is not verified possession. The adapter throws
  `UNSUPPORTED` 501 because V1 has no enrollment endpoint.
- Needed: a V1 relay enrollment endpoint with a real challenge/verify step that
  proves device possession and returns an account-scoped device record.

## Canonical machine identity vs legacy account-scoped deviceId

The V1 `/api/directory` contract exposes only an account-scoped legacy
`deviceId`; it is not a canonical machine identity. The same legacy string may
legitimately be reused by two accounts, and the relay store keys devices as
`(userId, deviceId)`. Therefore accounts must not turn this legacy field into a
globally unique canonical key.

Needed V1 relay interface: the enrollment challenge/verify step must return a
canonical `machineId` with `ownerAccountId`; the directory must expose that
canonical identity (or an explicit mapping) while keeping the legacy
account-scoped `deviceId` only for compatibility. Server-side uniqueness and
revocation must key on canonical identity, not the legacy string. Until this
endpoint exists, `V1RelayAdapter.enroll` keeps the typed `UNSUPPORTED` 501 gap,
`MachineService.enrollMachine` keeps only the local same-account `deviceId`
check, and no V2 code may invent a canonical machine identity.

## 4. Server-enforced cross-account deviceId uniqueness

- V1 relay currently returns account-scoped directory devices; it does not
  enforce a single owner per deviceId across accounts.
- V2 surface: uniqueness is asserted locally against the authenticated
  account's directory before delegation. This prevents same-account duplicates
  but cannot prevent two different accounts from claiming the same deviceId
  until V1 enforces it server-side.
- Needed: V1 relay server enforces one owner per deviceId and rejects a second
  account claiming an already-owned deviceId.


