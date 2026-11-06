# zterm-v2-members-impl-1103 evidence

Members module R1: runtime configuration ownership, AuthContext authorization,
binding CAS, and the consistent runtime reader for routing. Host verification
can prove session/anchor reachability, but the current run has no authoritative
machine-identity provider; that gap is explicit. The public entries are the only
exercised surface; store implementation stays internal. No secrets are recorded.

## Public entries

- `v2/modules/members/src/public/index.mjs` -> `createMembersService`,
  `createBindingStore`, `MEMBER_ERROR_CODES`.
- Organization reader used only for structure and member existence:
  `organization.getMember(memberId)`.
- Auth adapter: `v2/modules/members/tests/support/trusted-auth-double.mjs` is a
  TEST DOUBLE for the accounts verifySession port. It is not a production
  account store. It returns the AuthContext shape the real accounts module is
  expected to return (`{ accountId, scopes, workspaces }`).
- Host probe port: injected into `createMembersService`. The test-owned
  `createTmuxSessionProbe` fixture proves real tmux session/anchor existence and
  returns `machineId: null`; it is not a production host adapter.

## Commands

Run the members Node tests from the mounted task workspace root. The current
run used `4:/workspaces/1`; use the active mount handle when regenerating.

```sh
LAYERFS_PROJECT=zterm layerfs workspace exec 4:/workspaces/1 \
  'node --test v2/modules/members/tests/*.test.mjs' \
  --stream
```

Generate the real-tmux receipt through the public service entries:

```sh
LAYERFS_PROJECT=zterm layerfs workspace exec 4:/workspaces/1 \
  'node v2/evidence/zterm-v2-members-impl-1103/real-tmux-self-check.mjs' \
  --stream
```

`real-tmux-self-check.mjs` writes `real-tmux-receipt.json` next to itself.

## Expected vs actual (Node tests)

| Case | Expected | Actual |
| --- | --- | --- |
| configureRuntime persists machineId/hostKind/agentKind/launchProfileRef keyed by memberId | members store record | ok |
| configureRuntime survives a reopened store | same record | ok |
| configureRuntime changes machineId | old binding is deleted in the same store mutation | ok |
| configureRuntime changes hostKind/agentKind/launchProfileRef | old binding is deleted in the same store mutation | ok |
| invalidate then rebind after A -> B -> A | generation stays monotonic; the old generation is rejected | ok |
| AuthContext.members empty / other member / malformed | typed `MEMBER_FORBIDDEN_MEMBER` before store or probe | ok |
| AuthContext.members wildcard `'*'` | treated as malformed, typed `MEMBER_FORBIDDEN_MEMBER` | ok |
| legacy version-1 store without generations | counter backfilled from the existing binding; stale 0 rejected | ok |
| AuthContext.members exact allowlist for the target | action allowed | ok |
| AuthContext.members omitted | inherits workspace authorization | ok |
| bind by CAS | generation advances from expected | ok |
| stale binding generation | typed `BINDING_GENERATION_STALE` | ok |
| missing token | typed `UNAUTHENTICATED` before any store write | ok |
| wrong token | typed `UNAUTHENTICATED` before any store write | ok |
| missing members scope | typed `MEMBER_FORBIDDEN_SCOPE`, no side effect | ok |
| cross workspace / cross account target | typed `MEMBER_FORBIDDEN_WORKSPACE`, no side effect | ok |
| getRuntimeBinding with current runtime and binding | `{ machineId, bindingGeneration, sessionId, anchor }` from one snapshot | ok |
| getRuntimeBinding without runtime | typed `MEMBER_RUNTIME_NOT_CONFIGURED` | ok |
| getRuntimeBinding with a mismatched binding | typed `MEMBER_BINDING_INVALID` | ok |
| verifyHost with matching authoritative identity | `verified: true` | ok |
| verifyHost without authoritative identity | typed `BINDING_HOST_IDENTITY_UNAVAILABLE` | ok |
| verifyHost on different machine | typed `BINDING_HOST_MISMATCH` | ok |
| restore on matching host | `restored: true` | ok |
| restore without authoritative identity | typed `BINDING_HOST_IDENTITY_UNAVAILABLE` | ok |
| host unavailable | typed `BINDING_HOST_UNAVAILABLE` (retryable) | ok |

## Expected vs actual (real tmux)

The receipt uses a dedicated disposable tmux socket and only closes the named
sessions the script created. `createTmuxSessionProbe` reads `list-panes` to
confirm the bound anchor. It does not read or set a machine identity; the
missing authoritative provider is expected to produce the typed identity gap.

| Case | Expected | Actual |
| --- | --- | --- |
| bind real session $0 then $1 | generation 1 then 2 | ok |
| stale bind after generation 2 | typed `BINDING_GENERATION_STALE` | ok |
| configure A then B then A, reuse old generation 0 | typed `BINDING_GENERATION_STALE` | ok |
| rebind after invalidation with the current generation | generation advances to 3, not reissued | ok |
| verifyHost with live session but no authoritative identity | typed `BINDING_HOST_IDENTITY_UNAVAILABLE` | ok |
| restoreBinding with live session but no authoritative identity | typed `BINDING_HOST_IDENTITY_UNAVAILABLE` | ok |
| getRuntimeBinding reads one consistent member snapshot | matching machineId and generation | ok |
| configureRuntime changes machineId | old binding is deleted before the next reader | ok |
| runtime + binding survive reopened store | same records | ok |
| cross account target on real store | typed `MEMBER_FORBIDDEN_WORKSPACE`, no store change | ok |
| host sessions closed | typed `BINDING_HOST_UNAVAILABLE`, server not restarted | ok |

`real-tmux-receipt.json` is the structured receipt; `real-tmux-self-check.mjs`
regenerates it.

## Red evidence (pre-fix)

Running the three new tests against the unfixed `1216cc71` source failed all
three:

- `A -> B -> A` could not rebind without reissuing generation 1: the old code
  reset the counter to 0 after the binding was deleted.
- Changing `hostKind` alone left the old binding readable.
- Empty, other-member, and malformed `AuthContext.members` grants were not
  rejected.

All three pass on the fixed head. `real-tmux-receipt.json` records the
old-generation reuse rejection and the generation-3 rebind.

Follow-up intake on `12708063` added two narrow cases: a legacy version-1
store without `generations` accepted stale 0 and reissued generation 1 before
the backfill, and the wildcard `'*'` member grant was allowed instead of
rejected. Both now have dedicated tests and pass.

## Remaining cross-owner items

- Organization still stores `machineId/hostKind/agentKind/launchProfileRef` on
  `addMember`; removing those fields from organization is a cross-owner item and
  is handled by Jenny/Frank. Members does not read them for routing decisions.
- Organization records no workspace owner/account binding yet, so members
  enforces cross-account targeting through the AuthContext `workspaces` allowlist
  and returns `MEMBER_FORBIDDEN_WORKSPACE` for both cross-workspace and
  cross-account targets. A distinct cross-account code needs a
  workspace-ownership fact owned by organization/accounts.
- Members also enforces the AuthContext `members` allowlist: omitted
  inherits the workspace grant, an explicit string array allows only the
  listed memberIds, and an empty or malformed value (including `'*'`) is
  rejected with `MEMBER_FORBIDDEN_MEMBER` before any members store read/write
  or host probe.
- Routing must consume `members.getRuntimeBinding(memberId)` and use the
  returned `machineId` plus `bindingGeneration` from that one snapshot. Removing
  routing's organization `member.machineId` filter is the routing owner's task.
- Authoritative machine identity must come from the future host-adapters public
  probe. Until that port exists, `verifyHost` and `restoreBinding` explicitly
  return `BINDING_HOST_IDENTITY_UNAVAILABLE`; members does not own that identity.
