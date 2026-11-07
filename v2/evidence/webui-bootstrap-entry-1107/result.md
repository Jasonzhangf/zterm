# webui-bootstrap-entry-1107 result

Status: PASS (module slice, local candidate only)

## Delivered behavior

Added an isolated V2 WebUI first-run bootstrap surface:

- `#/setup` configures the daemon endpoint without triggering privileged authorization.
- Login calls the daemon account session API and reports typed failures instead of success.
- The workspace directory renders only server-authorized workspaces and keeps unauthorized and unavailable states explicit.
- Machine selection reads the server workspace tree.
- Machine enrollment is visibly disabled with `MACHINE_ENROLLMENT_UNAVAILABLE`.
- Workspace, group, and member configuration stays read-only.
- Desktop 1440x900 and mobile 390x844 layouts have no horizontal overflow.

## Changed paths

- `v2/modules/webui/src/clients/daemon-api/index.mjs`
- `v2/modules/webui/src/features/bootstrap/index.html`
- `v2/modules/webui/src/features/bootstrap/entry.mjs`
- `v2/modules/webui/src/features/bootstrap/bootstrap-app.mjs`
- `v2/modules/webui/src/features/bootstrap/pages/setup.mjs`
- `v2/modules/webui/src/features/bootstrap/pages/login.mjs`
- `v2/modules/webui/src/features/bootstrap/pages/workspaces.mjs`
- `v2/modules/webui/tests/contract/bootstrap-surface.test.mjs`
- `v2/modules/webui/tests/browser-e2e-bootstrap.mjs`
- `v2/evidence/webui-bootstrap-entry-1107/`

## Commands and results

- Red: `node --test v2/modules/webui/tests/contract/bootstrap-surface.test.mjs` -> exit 1, missing `bootstrap-app.mjs` (`ERR_MODULE_NOT_FOUND`). Log: `v2/evidence/webui-bootstrap-entry-1107/red-bootstrap.log`.
- Green: same command -> exit 0, tests 14, pass 14, fail 0. Log: `v2/evidence/webui-bootstrap-entry-1107/contract-green.log`.
- Browser: `node v2/modules/webui/tests/browser-e2e-bootstrap.mjs` -> exit 0, PASS. Evidence: `v2/evidence/webui-bootstrap-entry-1107/browser/e2e-result.json`.
- Layout: `node ./scripts/check-repo-layout.mjs` -> exit 0.
- Syntax: `node --check` on every new module and the extended daemon API client -> exit 0.
- Whitespace: `git diff --check` -> exit 0.

## Browser checks

- setup route rendered;
- endpoint saved without persisting a credential;
- wrong login returned typed `V2_CREDENTIAL_INVALID`;
- valid login showed authenticated state;
- missing `/api/workspaces` on the base daemon returned typed `METHOD_NOT_ALLOWED` unavailable;
- enrollment button disabled with `MACHINE_ENROLLMENT_UNAVAILABLE`;
- desktop 1440x900 scrollWidth 1440;
- mobile 390x844 scrollWidth 390.

## Deliberate boundaries

- Only `v2/modules/webui/**` and `v2/evidence/webui-bootstrap-entry-1107/**` were written.
- No daemon, accounts, organization, members, routing, terminal, goals, tickets, or board source was changed.
- Shared 3333/8801/8899 and tmux 16906 were untouched.
- The browser test used an isolated daemon on an ephemeral port with its own tmux socket.
- No commit was pushed, no merge or PR was created, and nothing was published.

## Remaining integration work

- Integrate the control-plane daemon branch so `GET /api/workspaces` exists at the same public entry.
- Replace the explicit in-memory workspace account token with server-session-derived authorization when the daemon owner lands the cookie-session shape from plan section 5.2.
- Add real machine enrollment endpoints before enabling the enrollment action.
- David reviews this module contract and evidence.
