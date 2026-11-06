# zterm V2 organization implementation evidence

Task: `zterm-v2-organization-impl-1103`

LayerFS project: `zterm`

LayerFS branch: `zterm-v2-organization-1103`

Owner: Frank. This worker run does not push, merge, integrate, or claim final
review acceptance.

## Public API

All operations come from `v2/modules/organization/src/public/index.mjs`.

Reads:

- `queryTree({ token, workspaceId }) -> { workspace, root }`

Mutations:

- `createWorkspace({ token, name, rootGroupName? })`
- `createGroup({ token, workspaceId, name, parentGroupId?, expectedRevision })`
- `updateGroup({ token, workspaceId, groupId, name?, parentGroupId?, expectedRevision })`
- `deleteGroup({ token, workspaceId, groupId, expectedRevision })`
- `addMember({ token, workspaceId, groupId, name, expectedRevision })`
- `updateMember({ token, workspaceId, memberId, name?, groupId?, expectedRevision })`
- `deleteMember({ token, workspaceId, memberId, expectedRevision })`
- `mountWorkspace({ token, workspaceId, parentGroupId, sourceWorkspaceId, name?, expectedRevision })`
- `unmountWorkspace({ token, workspaceId, mountId, expectedRevision })`

Trusted composition readers:

- `readWorkspace(workspaceId)`
- `getMember(memberId)`

Typed errors include the new organization codes:

- `ORGANIZATION_FORBIDDEN`
- `ORGANIZATION_REVISION_STALE`
- `MEMBER_NAME_CONFLICT`
- `GROUP_NOT_EMPTY`
- `ROOT_GROUP_PROTECTED`
- `MOUNT_NOT_FOUND`
- `MOUNT_NAME_CONFLICT`
- `MOUNT_CONFLICT`
- `MOUNT_CYCLE`
- `STORE_PERSIST_FAILED`

## Bounded rework added after Organization1253aac4 intake

- `DESIGN.md` now draws read and mutation paths separately and joins every typed
  success/failure at one public result, including `STORE_PERSIST_FAILED` from
  the atomic persist step.
- `DESIGN.md` records that a mount node is a reference only: `queryTree` does not
  expand the source tree, and any downstream expansion must reauthorize the
  source workspace with the AuthContext of that read.
- `organization.test.mjs` adds a real public-consumer concurrent case: A->B and
  B->A are issued together on the single store authority, exactly one succeeds,
  the other rejects with `MOUNT_CYCLE`, and the reopened graph has one reference
  and no cycle.
- Persist failure is mapped to typed `STORE_PERSIST_FAILED` with retryable
  disposition in the same store update boundary; no new lock service or second
  write authority was added.

## Changed files on the task branch

- `v2/modules/organization/src/public/typed-error.mjs`
- `v2/modules/organization/src/public/dev-auth.mjs`
- `v2/modules/organization/src/adapters/organization-store.mjs`
- `v2/modules/organization/src/application/organization-service.mjs`
- `v2/modules/organization/tests/organization.test.mjs`
- `v2/modules/organization/DESIGN.md`
- `v2/evidence/zterm-v2-organization-impl-1103/README.md`
- `v2/evidence/zterm-v2-organization-impl-1103/self-check.mjs`
- `v2/evidence/zterm-v2-organization-impl-1103/receipt.json`
- `v2/evidence/zterm-v2-organization-impl-1103/red-run.txt`
- `v2/evidence/zterm-v2-organization-impl-1103/test-pass.txt`
- `v2/evidence/zterm-v2-organization-impl-1103/self-check.txt`
- `v2/evidence/zterm-v2-organization-impl-1103/persist-failure.txt`

## Verification

```sh
node --test v2/modules/organization/tests/organization.test.mjs
node v2/evidence/zterm-v2-organization-impl-1103/self-check.mjs
```

Both commands run inside a fresh LayerFS workspace mounted from the task branch.
The receipt and the per-run text files record the exact command results. The
focused suite has 16 tests, including the concurrent A->B/B->A case.

The persist failure probe uses a fresh temp store whose atomic write target is
invalid; the public entry rejects with typed `STORE_PERSIST_FAILED` and
`retryDisposition=retryable`.

## Remaining dependencies

- Routing still reads `organization.member.machineId`; routing owner must migrate
  to `members.getRuntimeBinding`. This run does not modify routing.
- Members owns runtime configuration. Organization now keeps only structural
  member references.
- Accounts relay work remains separate and does not block this module.
