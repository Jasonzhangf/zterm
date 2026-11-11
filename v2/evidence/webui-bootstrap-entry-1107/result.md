# webui-bootstrap-entry-1107 result

Status: PASS (module slice, local candidate only)

## Delivered behavior

Added an isolated V2 WebUI first-run bootstrap surface:

- `#/setup` configures the daemon endpoint without triggering privileged authorization.
- Login uses the plan 5.2 `loginName`/`credential` account-session contract and reports typed failures instead of success.
- Logout failure preserves the verified session and typed error; logout success clears the session and workspace state.
- The workspace directory renders only server-authorized workspaces and keeps unauthorized and unavailable states explicit.
- Machine selection is explicitly unavailable with `MACHINE_SELECTION_UNAVAILABLE`; the member list is not treated as a machine registry.
- Machine enrollment is visibly disabled with `MACHINE_ENROLLMENT_UNAVAILABLE`.
- Workspace, group, and member configuration stays read-only.
- Desktop 1440x900 and mobile 390x844 layouts have no horizontal overflow.

## Changed paths

- `v2/modules/webui/src/features/bootstrap/daemon-client.mjs`
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
- Green: same command -> exit 0, tests 21, pass 21, fail 0.
- Browser: `node v2/modules/webui/tests/browser-e2e-bootstrap.mjs` -> exit 0, PASS. Evidence: `v2/evidence/webui-bootstrap-entry-1107/browser/e2e-result.json`.
- Layout: `node ./scripts/check-repo-layout.mjs` -> exit 0.
- Syntax: `node --check` on every new module and the bootstrap daemon client -> exit 0.
- Whitespace: `git diff --check` -> exit 0.

## Browser checks

- setup route rendered;
- endpoint saved without persisting a credential;
- wrong login returned typed `ACCOUNT_CREDENTIAL_INVALID`;
- valid login showed authenticated state;
- saved endpoint URL received all browser requests;
- authenticated workspace page rendered the authorized directory and member list;
- selection showed typed `MACHINE_SELECTION_UNAVAILABLE`;
- failed logout showed typed `ACCOUNT_REVOCATION_FAILED` and kept the authenticated session;
- enrollment button disabled with `MACHINE_ENROLLMENT_UNAVAILABLE`;
- desktop 1440x900 scrollWidth 1440;
- mobile 390x844 scrollWidth 390.

## Deliberate boundaries

- Only `v2/modules/webui/**` and `v2/evidence/webui-bootstrap-entry-1107/**` were written.
- No daemon, accounts, organization, members, routing, terminal, goals, tickets, or board source was changed.
- Shared 3333/8801/8899 and tmux 16906 were untouched.
- The browser test used a custom `node:http` public-shape fixture on an ephemeral
  port, with hardcoded `alice` account and workspace responses. Browser
  account/list/tree behavior is fixture-scope only; real account daemon
  composition remains pending.
- No commit was pushed, no merge or PR was created, and nothing was published.

## Rework mapping (David verdict 2026-11-07)

1. Saved endpoint is now used, not just stored. `entry.mjs` no longer builds a
   fixed empty-base client; `bootstrap-app.mjs` calls `daemonApi.setBaseUrl(...)`
   on save and again before session lookup, and invalidates session plus
   workspace load state when the endpoint changes. Cross-origin endpoints are
   rejected with typed `DAEMON_ENDPOINT_CROSS_ORIGIN_UNAVAILABLE`. The browser
   run asserts every request goes to the saved endpoint, and the contract test
   asserts `POST /api/auth/login` reaches the configured `http://127.0.0.1:9999`
   base instead of the page origin.
2. Auth now uses the plan 5.2 account-session contract on the bootstrap-owned
   client (`features/bootstrap/daemon-client.mjs`). `login` posts
   `{ loginName, credential }`, `sessionState` requires the `account` view,
   and the `accountWorkspaceToken`/`Bearer` path is removed. A legacy
   daemon-token success without a verified account is rejected with typed
   `ACCOUNT_SESSION_UNAVAILABLE`.
3. Logout preserves the typed failure and the verified session and keeps a retry
   path; only a confirmed server revocation clears the session and workspace
   state. Pending workspace list and tree loads are invalidated on
   logout/login/endpoint change, and a stale member list cannot render under a
   newer selected workspace.
4. Machine selection is explicit: the member list renders read-only with typed
   `MACHINE_SELECTION_UNAVAILABLE` and no select-machine action, and enrollment
   stays disabled with typed `MACHINE_ENROLLMENT_UNAVAILABLE`. Machine identity
   is not inferred from member display names.

## Re-verification commands (this rework)

- `node --test v2/modules/webui/tests/contract/bootstrap-surface.test.mjs` -> exit 0, 21/21; see `contract-green.log`.
- `node v2/modules/webui/tests/browser-e2e-bootstrap.mjs` -> exit 0, PASS; see `browser-e2e-green.log` and `browser/e2e-result.json`.
- `node ./scripts/check-repo-layout.mjs` -> exit 0; see `repo-layout-green.log`.
- `git diff --check` -> exit 0.

## Targeted rework rev3 (David verdict 2026-11-08)

1. The shared `v2/modules/webui/src/clients/daemon-api/index.mjs` is restored
   to the current main contract: terminal `login(token)`, terminal stream,
   `sendInput`, `getWorkspace`, and `listWorkspaceMembers`. It no longer
   carries the bootstrap account-session client. Bootstrap now owns a
   standalone account-session client at
   `v2/modules/webui/src/features/bootstrap/daemon-client.mjs`, so the terminal
   source consumer `clients/terminal-client/index.jsx` keeps its existing
   `api.login(token.trim())` call shape, and the main workspace/member surface
   remains intact. Contract tests assert the terminal call shape still posts
   `{ token: "terminal-token" }` and `getWorkspace`/`listWorkspaceMembers`
   still work against the shared client. No silent token fallback was added;
   the bootstrap client is the single account-session implementation in this
   slice.
2. The bootstrap client now preserves the session CSRF when `setBaseUrl` is
   called with an unchanged endpoint and clears it only when the endpoint
   actually changes. `logout` sends `x-zterm-csrf` on the POST. The browser
   fixture enforces the header, and both a forced failed logout retry and a
   successful retry are exercised end to end.
3. Evidence wording now correctly labels the browser harness as a
   `node:http` public-shape fixture, not an isolated daemon with its own tmux
   socket, and the stale fixture-only `daemon.log` plus
   `desktop-workspaces-unavailable.png` were removed. Fixture-scope behavior is
   not claimed as real daemon composition.

## Remaining integration work

- The shared `v2/modules/webui/src/clients/daemon-api/index.mjs` stays on the
  main terminal/workspace contract. The terminal surface
  `clients/terminal-client/index.jsx` and its runtime
  `features/terminal/bundle.js` still use `api.login(token)`; the terminal
  entry owner or composition owner must migrate that surface to the account
  contract in its own scope before it is rebuilt from source.
- Route the combined daemon account-session prerequisite so the same public entry serves `loginName`/`credential` sessions and the workspace reads.
- Add real machine enrollment endpoints before enabling the enrollment action.
- Add the member runtime and resolve edge before enabling machine selection.
- David reviews this module contract and evidence.
