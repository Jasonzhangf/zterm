# accounts workspace authorization architecture mapping

## Affected DAG

The V2 workspace currently has no persisted accounts DAG file. The affected object
flow is the linear control-plane path described in
`v2/docs/architecture.md` and the closure plan:

`verified relay session -> account-scoped authorization policy -> workspace/member context`

and

`verified relay session -> account-scoped machine directory -> typed route proof -> authorized machine link`

Both flows have one entry (`AuthService.verifySession`), one terminal success
(`WorkspaceAuthorizationContext` or `AuthorizedMachineLink`), and explicit typed
failure terminals. No back edge or second authority is introduced.

## Owner and Gap

- Owner: `v2/modules/accounts`.
- Gap class: `补链`.
- The existing `AuthContext` describes relay identity and session validity only.
  It has no `scopes`, `workspaces`, or `members`, so it must not be overloaded.
- No public accounts port currently converts a verified session into workspace
  authorization or an active canonical machine link.

## Method to Architecture

- Keep workspace policy in a separate persistent accounts-owned record keyed by
  stable `accountId`.
- Keep workspace and member references as stable IDs. No wildcard grant is
  implicit.
- Read canonical machine identity from `MachineService.listAuthorizedMachines`.
  Require matching non-empty `daemonHostId` evidence from typed route config
  before returning a machine link.
- Do not read another module's private store and do not move development auth or
  fixtures into production composition.

## Required Gates

- Red contract test: new public behavior fails before implementation.
- Green contract and integration tests: `node --test` for the accounts module.
- Real-relay combination gate: `AuthService` and `MachineService` backed by the
  isolated `V1RelayAdapter` drive both new factories end to end (login, missing
  grant, cross-account, unknown, missing identity proof, revocation, logout).
- Syntax checks on every changed TypeScript file.
