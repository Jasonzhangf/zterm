# Accounts public runtime architecture mapping

Long-term goal: V2 can compose a real account login and an explicit
workspace/machine authorization lifecycle without introducing a second account
authority or treating a token alone as permission.

## Affected graph

The existing `workspace.control_plane` graph starts with
`daemon.control_plane.authorize`. Its input requires both an active relay
session and an accounts-owned workspace grant. The existing
`workspace.member_resolve` graph consumes the resulting authorized context and
reads `bindingGeneration` from members.

This task fills the missing accounts-owned producer for that first node:

```text
login(loginName, credential)
  -> V1RelayAdapter.authenticate
  -> relay-issued session + stable accountId

grant(admin session, accountId, workspaceIds, machineIds)
  -> relay session revalidation
  -> relay directory caller-account confirmation
  -> relay machine list canonical-active/owner validation
  -> accounts policy store (single writer)
  -> authorization generation

verifyAuthority(session, workspaceId, machineId)
  -> relay session revalidation
  -> current accounts policy
  -> exact workspace/machine scope and generation match
  -> authority result or typed rejection

revoke(admin session, accountId)
  -> relay session revalidation
  -> delete accounts policy
  -> increment revocation generation
  -> old grant and bindingGeneration are rejected
```

All paths end in one typed result or one typed `AccountsError`. The public
entry does not open a connection, read a member binding, or write members.
The current V1 relay directory and machine list are caller-scoped. A target
account other than the authenticated caller therefore has no relay-owned
lookup and is rejected as `UNSUPPORTED` 501 before `putGrant`.

## Ownership

- Owner: `v2/modules/accounts`.
- Authority for identity and login sessions: V1 relay through
  `V1RelayAdapter`.
- Authority for workspace/machine grants: the accounts-owned persistent policy
  store.
- Owner of member `bindingGeneration`: members/routing. Accounts publishes the
  grant generation that a binding was authorized against; it does not write
  the member binding.
- Change class: fill the missing public composition edge and explicit
  revocation lifecycle. No existing graph topology or foreign module changes
  are required.

## Gates

1. Red public-entry contract test fails before implementation.
2. Real relay HTTP tests cover successful login, bad credentials, unknown
   account, and logout rejection.
3. Persistent policy tests cover grant, exact workspace/machine verification,
   cross-workspace and cross-machine rejection, and revocation of an existing
   grant and generation.
4. `node --check` covers the public JS entry.
5. Focused `node --test` covers public entry and existing accounts contracts.

The task workspace is
`/Volumes/Intel/playground/zterm/worktrees/accounts-authority-runtime-entry-20261108`.
The board `start` command returned `TICKET_PHASE_NOT_CLAIMED`, and `relocate`
rejected this contract path because its basename exceeds the configured slug
limit or does not match the configured layout. Those receipts are retained;
the task remains working and no lifecycle success is claimed.
