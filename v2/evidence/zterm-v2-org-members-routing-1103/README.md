# zterm-v2-org-members-routing-1103 evidence

Increment 1 for the V2 organization, members, and routing modules. The public entries
are the only exercised surface; store implementation stays internal. No secrets are
recorded.

## Public entries

- `v2/modules/organization/src/public/index.mjs` -> `createOrganizationService`,
  `createOrganizationStore`, `createDevVerifiedAuth`.
- `v2/modules/members/src/public/index.mjs` -> `createMembersService`, `createBindingStore`.
- `v2/modules/routing/src/public/index.mjs` -> `createRoutingService`.

The dev verified-auth adapter only maps an opaque bearer token to a pre-registered
AuthContext. It is not an account store and the caller never supplies account identity.

## Commands

Run the full increment test suite from the LayerFS workspace root (`/workspaces/6`):

```sh
LAYERFS_PROJECT=zterm layerfs workspace exec 3:/workspaces/6 \
  'node --test v2/modules/organization/tests/*.test.mjs v2/modules/members/tests/*.test.mjs v2/modules/routing/tests/*.test.mjs' \
  --stream
```

Generate the receipt through the public entries:

```sh
node v2/evidence/zterm-v2-org-members-routing-1103/receipt.mjs \
  v2/evidence/zterm-v2-org-members-routing-1103/receipt.json
```

## Expected vs actual

| Case | Expected | Actual |
| --- | --- | --- |
| create workspace + nested group | returns stable `workspaceId` / `groupId` | ok |
| reopen over the same store file | same stable ids and tree | ok |
| duplicate group name, same parent | typed `GROUP_NAME_CONFLICT` | ok |
| same group name, different parents | succeeds with distinct paths | ok |
| add member fields | memberId, groupId, name, machineId, hostKind, agentKind, launchProfileRef | ok |
| bind by CAS | generation advances from expected | ok |
| stale binding generation | typed `BINDING_GENERATION_STALE` | ok |
| resolve address | memberId, machineId, bindingGeneration | ok |
| unknown address/member | typed `ROUTE_NOT_FOUND` | ok |
| reachable ambiguous address | typed `ROUTE_AMBIGUOUS` | ok |
| missing/unverified auth | typed `UNAUTHENTICATED` before any store mutation | ok |

`receipt.json` is the structured public-entry receipt; `receipt.mjs` regenerates it.
