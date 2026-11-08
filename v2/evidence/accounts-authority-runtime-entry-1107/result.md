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
