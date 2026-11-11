# WebUI bootstrap entry evidence

Task: `webui-bootstrap-entry-1107`

Worktree: `/Volumes/Intel/playground/zterm/worktrees/webui-bootstrap-entry-20261107`

Branch: `webui-bootstrap-entry-20261107`

Base: `f99a61a8`

Public entry: `/features/bootstrap/index.html#/setup`

## Contract mapping

| Required behavior | Evidence |
| --- | --- |
| `/setup` configures the daemon endpoint and performs no privileged authorization silently | setup form only saves the endpoint; login is a separate explicit form submit |
| Login uses the daemon account session API and keeps credentials out of storage | `POST /api/auth/login`; credential is in memory only; no credential appears in `localStorage` |
| Workspace directory lists only server-authorized workspaces and shows typed errors | `GET /api/workspaces` with the server-owned session cookie; 401/403 -> unauthorized; 404/405/501/503 -> unavailable |
| Machine selection is explicit; enrollment is visibly disabled with a typed reason | member list from `GET /api/workspaces/:workspaceId/tree`; selection unavailable with `MACHINE_SELECTION_UNAVAILABLE`; enrollment button disabled with `MACHINE_ENROLLMENT_UNAVAILABLE` |
| Workspace/group/member configuration stays read-only | the page renders the directory and note only; no mutation controls |
| Desktop 1440x900 and mobile 390x844 have no horizontal overflow | `browser/e2e-result.json` |
| No fake success | browser run uses a `node:http` public-shape fixture and labels its scope; missing `/api/workspaces` is reported as typed unavailable |

## API shape consumed

The daemon control-plane shape from `control-plane-org-members-routing-1106` is:

- `POST /api/auth/login`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET /api/workspaces`
- `GET /api/workspaces/:workspaceId/tree`
- `GET /api/workspaces/:workspaceId/members/:memberId/runtime`
- `POST /api/workspaces/:workspaceId/resolve`

This slice consumes login/session/logout plus the workspace list and tree reads. Authentication follows plan section 5.2: `POST /api/auth/login` with `loginName`/`credential`, and authorization comes from the server-owned session cookie. The browser sends no Bearer token and stores no credential. It rejects a legacy token-login success that returns no verified account with typed `ACCOUNT_SESSION_UNAVAILABLE`.

## Commands

| Command | Result |
| --- | --- |
| `node --test v2/modules/webui/tests/contract/bootstrap-surface.test.mjs` (red) | exit 1, `ERR_MODULE_NOT_FOUND` before implementation; see `red-bootstrap.log` |
| `node --test v2/modules/webui/tests/contract/bootstrap-surface.test.mjs` | exit 0, 20/20 pass; see `contract-green.log` |
| `node v2/modules/webui/tests/browser-e2e-bootstrap.mjs` | exit 0, PASS; see `browser/e2e-result.json` |
| `node ./scripts/check-repo-layout.mjs` | exit 0 |
| `node --check` on all new modules and the bootstrap daemon client | exit 0 |
| `git diff --check` | exit 0 |

## Browser evidence

- `browser/desktop-login-error.png`: wrong credential shows typed `ACCOUNT_CREDENTIAL_INVALID`.
- `browser/desktop-workspaces.png`: authenticated workspace page shows the authorized directory, the member list, and the typed selection/enrollment unavailable reasons.
- `browser/desktop-logout-error.png`: failed logout shows typed `ACCOUNT_REVOCATION_FAILED` and keeps the authenticated session; the retry then succeeds.
- `browser/mobile-setup.png`: 390x844 setup page with no horizontal overflow.
- `browser/e2e-result.json`: machine-readable PASS summary and overflow measurements.

## Known limits

- The browser run uses a `node:http` public-shape fixture with a hardcoded `alice` account and workspace responses. It proves the UI contract, not production account data or daemon wiring. This is fixture-scope only.
- The daemon control-plane shape does not expose machine enrollment mutations. The action is disabled with a typed reason.
- Machine selection needs the member runtime and resolve edge. This surface does not infer machine identity from member display names, so it reports typed `MACHINE_SELECTION_UNAVAILABLE` until that public edge exists.
- If the combined daemon has not implemented the account-session contract, the UI reports typed `ACCOUNT_SESSION_UNAVAILABLE` instead of relabeling legacy token success as an account login. The daemon session prerequisite belongs to the daemon owner.
- No push, merge, PR, or publish was performed.
