# Observation

Goal: inspect the existing accounts public surface and prove the missing
public runtime before changing implementation.

Observed:

- `src/public/contracts.ts` exports TypeScript services and types, but there is
  no `src/public/index.mjs`.
- `AuthService.login` delegates to the injected relay authority.
- `WorkspaceAuthorization` reads persistent account grants.
- `AccountsAuthorizationAdapter` verifies a relay session, canonical machine
  ownership, and route identity.
- The current grant record has workspace/member scopes but no machine scope or
  explicit generation.
- Existing `MachineService.grantMachineAccess` rejects cross-account access.
- The accounts public entry therefore cannot currently provide the task's
  workspace plus machine grant/revocation lifecycle.
- Baseline accounts contract tests: 64 passed, exit 0.
- Full accounts test command: 64 passed, 2 integration tests failed before
  their bodies because `android/node_modules/.bin/tsx` is absent from the new
  worktree. The exact error is `spawn .../android/node_modules/.bin/tsx ENOENT`.

Unknown before implementation:

- Whether the public entry can be imported directly by Node while reusing the
  existing TypeScript services.

Next: add a red public-entry test that exercises the contract through
`src/public/index.mjs`, then implement only the missing composition and
authorization lifecycle.
