# accounts workspace authorization adapters result

## Delivered behavior

- Added an accounts-owned persistent authorization policy store keyed by stable
  `accountId` and stable workspace/member IDs.
- Added `createWorkspaceAuthorization` with active-session verification,
  explicit grant lookup, and post-create workspace binding.
- Kept `WorkspaceAuthorizationContext` separate from relay `AuthContext`.
- Added `createAccountsAuthorizationPort` for canonical active-machine
  authorization through `MachineService.listAuthorizedMachines`.
- Required matching non-empty route/target `daemonHostId` evidence before
  returning `AuthorizedMachineLink`.
- Added typed errors
  `WORKSPACE_AUTHORIZATION_REQUIRED`, `WORKSPACE_FORBIDDEN`, and
  `MACHINE_IDENTITY_UNVERIFIED`.
- Kept session tokens, credentials, and machine connection tokens out of
  persisted policy and machine-identity error details.

## Repeated commands and results

Red test before implementation:

```sh
node --test v2/modules/accounts/tests/contract/accounts-authorization.test.ts
```

Result: failed because the new public exports did not exist. Exact output is
in `red-test.txt`.

Full accounts module gate:

```sh
pnpm --dir v2/modules/accounts test
```

Result: 64 tests passed, including the isolated real V1 relay integration.
Receipts are in `green-package-tests.txt` and `green-tests.txt`.

Syntax and scope gates:

```sh
node --check <each changed TypeScript file>
git diff --check
```

Result: both gates exited 0. The syntax receipt is in `syntax-checks.txt`.

The integration test requires workspace dependencies for the isolated relay
launcher. They were restored from the local pnpm store with:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

No source dependency or lockfile changed.

## Rework: real-relay combination evidence

Review finding P1 required the new adapters to be exercised through the real V1
relay, not only in-memory authority.

Added one combined case to the existing isolated real-relay integration entry
(`tests/integration/accounts-flow.test.ts`). It publicly builds `AuthService`,
`MachineService`, `createWorkspaceAuthorization`, and
`createAccountsAuthorizationPort` against the real `V1RelayAdapter` and the
persistent accounts store. It covers real login authorization, missing grant,
cross-account rejection, unknown machine, missing or inconsistent daemon-host
identity proof, owner revocation, and logout.

Sensitivity red: with the production revoked-status guard temporarily removed,
the new case fails at the `MACHINE_REVOKED` assertion (see
`red-rework-test.txt`). Restoring the guard and re-running the module gate
passes 66 tests (see `green-package-tests.txt`).

## Boundaries

- Changed paths are limited to `v2/modules/accounts/**` and
  `v2/evidence/accounts-workspace-auth-adapters-1106/**`.
- No organization, members, routing, daemon, WebUI, or connections source was
  modified.
- No shared port, tmux server, device, service lifecycle, push, merge, publish,
  or PR operation was used.
- No project memory, project Skill, or AGENTS file was modified.

## Remaining P1-A integration gap

The accounts public adapters and their isolated real-relay behavior are ready
for review. Daemon composition, product connectivity, and remote real-entry E2E
remain with Grace/Jenny and the corresponding integration owners.
