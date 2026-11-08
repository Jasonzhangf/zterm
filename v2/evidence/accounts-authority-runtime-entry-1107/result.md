# accounts public authority runtime result

Status: local candidate ready for independent review. No push, merge, publish,
daemon restart, or tmux lifecycle action was performed.

Branch: `accounts-authority-runtime-entry-20261108`

Base: local main `6ad4a33525db78e2ad2b7318a6c42ce6d335c75b`

## Delivered behavior

`v2/modules/accounts/src/public/index.mjs` now exports
`createAccountsRuntime({ relayBaseUrl, authorizationStoreFile })` with
`login`, `grant`, `revoke`, and `verifyAuthority`.

The public call chain is:

```text
login -> V1RelayAdapter.authenticate -> relay POST /api/auth/login
grant -> AuthService.verifySession -> relay GET /api/auth/me
      -> accounts policy store -> new authorization generation
revoke -> AuthService.verifySession -> relay GET /api/auth/me
       -> accounts policy store delete -> generation retained
verifyAuthority -> AuthService.verifySession -> relay GET /api/auth/me
                -> current accounts grant -> exact workspace/machine match
```

The accounts policy store keeps one grant per account. A grant stores exact
workspace IDs, exact machine IDs, scopes, and an accounts-owned
`authorizationGeneration`. Revoking deletes the current grant but retains the
last generation, so a later grant receives a higher generation. The public
result projects that generation as `bindingGeneration`; members still own the
member binding generation.

Unknown credentials, unknown accounts, missing grants, wrong workspaces, wrong
machines, and stale or revoked generations return typed `AccountsError`
rejections.

## Evidence

- Red-first receipt: `red-public-runtime.txt`. It shows the public entry import
  failed before implementation.
- Focused contract tests:
  `node --test v2/modules/accounts/tests/contract/public-runtime.test.ts`.
  Result: 4 passed, 0 failed.
- Full accounts tests:
  `node --test v2/modules/accounts/tests/contract/*.test.ts v2/modules/accounts/tests/integration/*.test.ts`.
  Result: 71 passed, 0 failed. Receipt: `green-accounts-tests.txt`.
- Real relay public-entry test:
  `node --test v2/modules/accounts/tests/integration/accounts-flow.test.ts`.
  Result: 3 passed, 0 failed. Receipt: `green-real-relay-tests.txt`.
  The test starts an isolated V1 traversal relay, registers real relay
  accounts, uses the public runtime over real HTTP, and does not replace the
  relay authority with a memory store.
- Syntax and diff checks: `syntax-checks.txt`.
- Affected DAG validation: both `workspace.control_plane@0.1` and
  `workspace.member_resolve@0.1` validate.
- Changed paths: `changed-paths.txt`.

## Boundary

The patch is limited to `v2/modules/accounts/**` and this task evidence
directory. It does not modify members, daemon, host-adapters, transports, or
shared ports.

Production daemon composition, member binding writes, remote deployment,
push, and merge remain outside this task. Those items are not claimed as
verified.

The authoritative project requirements file `.appsdk/requirements.json` does
not exist at the candidate root; it was skipped under the review standards.

## Rework 2026-11-08: P1 grant target authority

The independent review found that `grant` persisted `request.accountId` and
`request.machineIds` after checking only the caller session. The rework adds a
relay-owned validation step before `putGrant`:

- The target account must match the account returned by relay
  `GET /api/directory` for the authenticated caller.
- Every requested machine must be returned by relay `GET /api/machines` as a
  canonical active machine owned by that account.
- Unknown, cross-account, and revoked machines are rejected with typed
  `AccountsError` results. The policy store is not changed.
- V1 relay has no arbitrary target-account or target-machine lookup. A target
  account different from the relay directory caller is rejected with explicit
  `UNSUPPORTED` 501, so no unverifiable cross-account authority is persisted.

### Rework evidence

- Red public contract:
  `v2/evidence/accounts-authority-runtime-entry-1107/rework-red-public-runtime.txt`
- Red real relay:
  `v2/evidence/accounts-authority-runtime-entry-1107/rework-red-real-relay-tests.txt`
- Green focused public contract:
  `v2/evidence/accounts-authority-runtime-entry-1107/rework-green-public-runtime-contract.txt`
  (`5 passed, 0 failed`, exit 0)
- Green real relay:
  `v2/evidence/accounts-authority-runtime-entry-1107/rework-green-real-relay-tests.txt`
  (`3 passed, 0 failed`, exit 0)
- Green complete accounts suite:
  `v2/evidence/accounts-authority-runtime-entry-1107/rework-green-accounts-tests.txt`
  (`72 passed, 0 failed`, exit 0)
- Syntax and diff checks:
  `v2/evidence/accounts-authority-runtime-entry-1107/rework-syntax-diff-checks.txt`

Changed paths for the rework:

- `v2/modules/accounts/src/application/accounts-authority-runtime.ts`
- `v2/modules/accounts/tests/contract/public-runtime.test.ts`
- `v2/modules/accounts/tests/integration/accounts-flow.test.ts`
- `v2/modules/accounts/DESIGN.md`
- `v2/evidence/accounts-authority-runtime-entry-1107/architecture-mapping.md`
- `v2/evidence/accounts-authority-runtime-entry-1107/changed-paths.txt`
- `v2/evidence/accounts-authority-runtime-entry-1107/result.md`
- the `rework-*.txt` receipts in this evidence directory

No affected DAG topology changed, so the existing `workspace.control_plane@0.1`
and `workspace.member_resolve@0.1` graph files were not modified. The remaining
boundary is the V1 relay capability gap: cross-account grant target lookup is
not available, so that path remains `UNSUPPORTED` until the relay owner adds a
scoped lookup contract. No push, merge, publish, daemon restart, tmux action,
or global installation was performed.
