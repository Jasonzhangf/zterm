# Real V1 relay server consumer evidence

Date: 2026-11-03
Task: zterm-v2-accounts-impl-1103
Branch: zterm-v2-accounts-core-1103

## Server under test

- Source: read-only V1 tree
  `/Volumes/extension/code/zterm/android/src/traversal-relay/server.ts`
- Start:
  `ZTERM_TRAVERSAL_PORT=19334 ZTERM_TRAVERSAL_HOST=127.0.0.1 ZTERM_TRAVERSAL_STORE_PATH=<run>/store.json ZTERM_TRAVERSAL_DATA_DIR=<run> ./android/node_modules/.bin/tsx android/src/traversal-relay/server.ts`
- Store and data directory: isolated
  `/Volumes/Intel/playground/zterm/.worker-runs/zterm-v2-accounts-impl-1103/relay-probe/`
- Production `~/.zterm` was not used. No production relay or daemon was started,
  stopped, or restarted.

## Consumer

`relay-real-server-self-check.mjs` imports the public accounts entry
`src/public/contracts.ts` and drives `AuthService`, `MachineService`, and the
real `V1RelayAdapter` over global `fetch`. It covers:

1. register through `POST /api/auth/register`
2. duplicate registration rejection
3. login through `POST /api/auth/login`
4. session verification through `GET /api/auth/me`
5. directory listing through `GET /api/directory`

## Pre-fix red result

The real relay returned the actual directory envelope:

`{ ok, user, directory: { schemaVersion, user, devices, updatedAt } }`

The existing adapter passed the outer envelope into `#toDirectory`. The consumer
failed with:

`AccountsError: relay directory schema version is unsupported`
`code=RELAY_PROTOCOL_ERROR status=502`

This failure is the missing real-contract edge: the earlier isolated
`relay-compose-self-check.mjs` used a hand-written fixture with the directory
fields at the top level.

## Fix

`V1RelayAdapter.getDirectory` now unwraps `body.directory` when present and keeps
the direct body path as a compatibility shape. A regression test covers the real
server envelope in
`tests/contract/v1-relay-errors.test.ts`.

## Post-fix green result

`relay-real-compose-ok base=http://127.0.0.1:19334 account=<redacted-id> register->login->verifySession->list`

The final accounts test batch also passed:

`node --test tests/contract/*.test.ts tests/integration/*.test.ts`

Result: exit 0, 48 tests pass, 0 fail.

## Two-account non-empty directory isolation

`relay-real-two-account-self-check.mjs` starts an isolated real V1 relay and
drives two registered accounts through `AuthService`, `MachineService`, and the
real `V1RelayAdapter`. Each account opens a real `/ws/host` connection and
publishes a distinct directory generation with one device and one session. The
two authenticated clients then list exactly their own machine; logging out one
local session does not remove its relay directory entry, and the other account
remains isolated.

Exact command run from the fresh final-head workspace `3:/workspaces/57`:

```bash
ZTERM_REAL_RELAY_BASE_URL=http://<host-gateway>:19337 \
  node v2/evidence/zterm-v2-accounts-impl-1103/relay-real-two-account-self-check.mjs
```

Result:

```text
relay-real-two-account-isolation-ok register->login->host-directory->isolated-list->logout-retains-machines
```

The script also passed the final-head module batch:

```bash
cd v2/modules/accounts
node --test tests/contract/*.test.ts tests/integration/*.test.ts
```

`48` tests passed, `0` failed. This uses the actual V1 relay HTTP and WebSocket
server with isolated store/data paths. It does not use production `~/.zterm`.

## Boundary not claimed

This run proves the supported V1 relay account/session/directory path used by
the accounts module, including non-empty two-account directory isolation and
local logout not deleting the relay directory entry. Remote revocation, explicit
machine enrollment, proof-of-possession verification, and server-enforced
cross-account deviceId uniqueness remain V1 relay-owner gaps.
