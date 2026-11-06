# zterm V2 accounts first increment acceptance (R3 real relay consumer)

Task: zterm-v2-accounts-impl-1103 (P1, feature).
Owner: Frank. Reviewer: David. Publisher: Jenny.
Branch: zterm-v2-accounts-core-1103. Head: current branch head at delivery.
Module root: /v2/modules/accounts.
Public entry: src/public/contracts.ts (AuthService, MachineService, V1RelayAdapter, AccountsError, relay ports).

## Authority boundary (R1 rework, kept)

The module does NOT own a second parallel account authority. It delegates
account/session/directory to the V1 public relay boundary via
`src/adapters/v1-relay.ts`:
- `POST /api/auth/login` -> accessToken + user.id/username
- `POST /api/auth/register` -> account identity only; registration does not
  mint or consume a session token
- `GET /api/auth/me` (bearer) -> re-validated session; the adapter backfills the
  caller token because the real endpoint does not echo `accessToken`
- `GET /api/directory` (bearer) -> account-scoped devices; the real envelope
  wraps the directory under `directory`

`src/adapters/in-memory-account-store.ts` is explicitly a TEST DOUBLE only; it
is not production authority. Remote logout revocation, machine enrollment, and
server-enforced cross-account deviceId uniqueness remain declared V1 gaps and
are never faked with a local store.

## Typed relay failure mapping (R2 fix)

The single adapter preserves the real failure class instead of collapsing every
non-2xx or transport fault into 401:

- fetch/network failure -> `RELAY_TRANSPORT_ERROR` 503 with the original error
  as `cause` and `details.cause`.
- upstream 429 -> `RELAY_SERVICE_ERROR` 429 with `details.upstreamStatus = 429`.
- other upstream non-2xx (5xx, 404, ...) -> `RELAY_SERVICE_ERROR` 502 with
  `details.upstreamStatus`.
- invalid JSON -> `RELAY_PROTOCOL_ERROR` 502 with the parse error as `cause`.
- 200 but missing required body fields -> `RELAY_PROTOCOL_ERROR` 502.
- real upstream 401 -> `AUTHENTICATION_REQUIRED` 401; real upstream 403 ->
  `SESSION_REVOKED` 403. No bypass and no blind retry.

## Verification command

```sh
cd /v2/modules/accounts
node --test tests/contract/*.test.ts tests/integration/*.test.ts
```

Node: v24.21.0 (LayerFS runtime image layerfs-zterm-runtime:node24-jdk17-android36-pnpm9).
Result: exit code 0, 48 tests pass, 0 fail.

Real isolated relay compose:

```sh
node v2/evidence/zterm-v2-accounts-impl-1103/relay-real-server-self-check.mjs
```

The real server is started from the read-only V1 tree with
`ZTERM_TRAVERSAL_STORE_PATH` and `ZTERM_TRAVERSAL_DATA_DIR` under an isolated
temporary directory, then the consumer runs through the public accounts entry.
Result: `relay-real-compose-ok register->login->verifySession->list`.

The first run against the real server exposed the actual `/api/directory`
envelope (`{ user, directory: { schemaVersion, user, devices, updatedAt } }`),
which the adapter initially treated as protocol-invalid. The adapter now unwraps
that real envelope and has a regression test for it. The pre-fix failure was
`RELAY_PROTOCOL_ERROR 502` at `relay directory schema version is unsupported`;
the post-fix run succeeded.

## Positive cases (real public flow over V1 relay boundary)

1. register (relay-user) -> login -> verifySession -> listAuthorizedMachines
   returns the same relay account and its isolated device directory.
2. login (alice) -> verifySession -> listAuthorizedMachines returns alice's
   directory device with ownerAccountId = acct-alice and stable accountId.
3. same-account isolation: alice and bob each list only their own devices.
4. logout invalidates locally; subsequent verifySession/list -> SESSION_REVOKED 403.
5. machine enrollment collects proof-of-possession material and reaches the V1
   gap only after same-account deviceId uniqueness checks pass.
6. `tests/integration/v1-relay-loopback.test.ts` drives `V1RelayAdapter` over a
   real `node:http` loopback relay with the global `fetch`, not an injected fake:
   register maps to account identity, login maps to a session, and `/me`
   without `accessToken` backfills the caller token.

## Rejection cases (typed errors, positive + negative)

1. duplicate register username -> ACCOUNT_EXISTS 409.
2. missing username or password -> INVALID_REQUEST 400.
3. wrong credential / unknown account -> AUTHENTICATION_REQUIRED 401 via V1 login.
4. missing/empty token -> AUTHENTICATION_REQUIRED 401.
5. revoked session after local logout -> SESSION_REVOKED 403 (local-only; no remote revocation claimed).
6. enrollMachine empty deviceId -> INVALID_REQUEST 400.
7. enrollMachine missing deviceToken material -> INVALID_REQUEST 400.
8. enrollMachine deviceId already owned by this account -> MACHINE_ALREADY_ENROLLED 409.
9. enrollMachine with material + unique device -> UNSUPPORTED 501 (V1 enrollment gap).
10. account B cannot list account A devices (same-account isolation).
11. grantMachineAccess / revokeMachineAccess -> CROSS_ACCOUNT_ACCESS_DISABLED 403; invalid token -> 401 first.
12. transport failure -> RELAY_TRANSPORT_ERROR 503; upstream 500 -> RELAY_SERVICE_ERROR 502;
    upstream 429 -> RELAY_SERVICE_ERROR 429; bad JSON -> RELAY_PROTOCOL_ERROR 502;
    200 missing token/account or unsupported directory schemaVersion -> RELAY_PROTOCOL_ERROR 502.
13. register upstream 401 -> AUTHENTICATION_REQUIRED 401 and 403 ->
    SESSION_REVOKED 403; 429 and 500 preserve service classifications.

## Machine enrollment wording (R2 fix)

The module collects proof-of-possession MATERIAL with a non-empty `deviceToken`.
A non-empty `deviceToken` is not verified possession. The V1 relay has no
challenge/verify endpoint, so possession verification remains a V1 relay gap.
Enrollment still returns `UNSUPPORTED` 501 until the relay owner supplies the
server endpoint; the module never fakes a successful enrollment.

## Coverage matrix

- tests/contract/auth-service.test.ts: auth cases.
- tests/contract/machine-service.test.ts: machine cases.
- tests/contract/v1-relay-errors.test.ts: typed adapter error mapping.
- tests/integration/accounts-flow.test.ts: composed real-consumer cases.
- tests/integration/v1-relay-loopback.test.ts: real loopback HTTP consumer.

## Non-goals (explicitly not claimed)

HTTP server, WebUI, daemon integration, cross-account grants, persistent
production DB, global install, merge/push. V1 missing APIs (revocation,
enrollment/possession, cross-account deviceId uniqueness) are relay-owner gaps,
not implemented here.

## Evidence

Host candidate source: /Volumes/Intel/playground/zterm/.worker-runs/zterm-v2-accounts-impl-1103/subworkers/rework-r2/product
Real relay observation: /Volumes/Intel/playground/zterm/.worker-runs/zterm-v1-relay-owner-verify-1103/observer-2/observation.md
Real relay consumer: v2/evidence/zterm-v2-accounts-impl-1103/relay-real-server-self-check.mjs


