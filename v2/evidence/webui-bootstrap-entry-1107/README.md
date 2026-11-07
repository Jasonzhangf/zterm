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
| Workspace directory lists only server-authorized workspaces and shows typed errors | `GET /api/workspaces` with `Authorization: Bearer`; 401/403 -> unauthorized; 404/405/503 -> unavailable |
| Machine selection uses the server tree; enrollment is visibly disabled with a typed reason | `GET /api/workspaces/:workspaceId/tree`; enrollment button disabled with `MACHINE_ENROLLMENT_UNAVAILABLE` |
| Workspace/group/member configuration stays read-only | the page renders the directory and note only; no mutation controls |
| Desktop 1440x900 and mobile 390x844 have no horizontal overflow | `browser/e2e-result.json` |
| No mock/demo success | browser run uses a real isolated daemon; missing `/api/workspaces` is reported as typed unavailable |

## API shape consumed

The daemon control-plane shape from `control-plane-org-members-routing-1106` is:

- `POST /api/auth/login`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET /api/workspaces`
- `GET /api/workspaces/:workspaceId/tree`
- `GET /api/workspaces/:workspaceId/members/:memberId/runtime`
- `POST /api/workspaces/:workspaceId/resolve`

This slice consumes login/session/logout plus the workspace list and tree reads. The browser sends the control-plane account token as a Bearer header. The token is entered in the explicit setup form scope and is held in memory only.

## Commands

| Command | Result |
| --- | --- |
| `node --test v2/modules/webui/tests/contract/bootstrap-surface.test.mjs` (red) | exit 1, `ERR_MODULE_NOT_FOUND` before implementation; see `red-bootstrap.log` |
| `node --test v2/modules/webui/tests/contract/bootstrap-surface.test.mjs` | exit 0, 14/14 pass; see `contract-green.log` |
| `node v2/modules/webui/tests/browser-e2e-bootstrap.mjs` | exit 0, PASS; see `browser/e2e-result.json` |
| `node ./scripts/check-repo-layout.mjs` | exit 0 |
| `node --check` on all new modules and the extended daemon API client | exit 0 |
| `git diff --check` | exit 0 |

## Browser evidence

- `browser/desktop-login-error.png`: wrong credential shows typed `V2_CREDENTIAL_INVALID`.
- `browser/desktop-workspaces-unavailable.png`: authenticated workspace page shows typed `METHOD_NOT_ALLOWED` unavailable state and disabled enrollment.
- `browser/mobile-setup.png`: 390x844 setup page with no horizontal overflow.
- `browser/daemon.log`: isolated daemon log.
- `browser/e2e-result.json`: machine-readable PASS summary and overflow measurements.

## Known limits

- Base `f99a61a8` daemon does not expose `/api/workspaces`; only `control-plane-org-members-routing-1106` adds it. The real-browser run therefore proves the typed unavailable state, not a real 200 workspace list. The 200 list path is covered by the contract test using the control-plane response shape.
- The daemon control-plane shape does not expose machine enrollment mutations. The action is disabled with a typed reason.
- Plan section 5.2 expects account identity to come from the server-verified session. The current control-plane candidate still reads the account token from a Bearer header. The UI keeps that token in memory only; final cookie-session wiring belongs to the daemon control-plane owner.
- No push, merge, PR, or publish was performed.
