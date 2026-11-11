# Plan

Long-term goal: provide a consumable accounts runtime that proves real login
and explicit authorization, rejects invalid or out-of-scope access, and makes
revocation invalidate an existing grant and its binding generation.

## Implementation

1. Extend the accounts-owned grant with exact `machineIds` and
   `bindingGeneration` fields. Keep accountId as the stable subject and do not
   store credentials or relay sessions.
2. Add an accounts authorization lifecycle service:
   - `grant`: revalidate the administrator session through relay; require an
     explicit all-workspaces `org:write` grant for the administrator; assign a
     new positive generation; persist exact workspace and machine IDs.
   - `revoke`: revalidate the administrator session; require the same
     management authority; delete the target grant. A later grant starts at a
     higher generation than the revoked one.
   - `verifyAuthority`: revalidate the caller session; match the stable account,
     exact workspace, exact machine, and current generation. No wildcard or
     token-only success.
3. Add `src/public/index.mjs` with the minimal JS factory and methods
   `login`, `grant`, `revoke`, and `verifyAuthority`. It composes
   `V1RelayAdapter`, `AuthService`, and the accounts-owned store.
4. Keep members/daemon/host-adapters unchanged.

## Tests

- Red first: public entry does not exist.
- Green: real isolated relay login succeeds; invalid and unknown credentials
  are typed 401 with no grant side effect.
- Green: grant allows the exact workspace/machine pair; cross-workspace and
  cross-machine attempts are typed 403.
- Green: revoke invalidates the old grant and bindingGeneration; a stale
  verification is typed 403; a new grant has a higher generation.
- Green: persistent file store contains no credentials or session tokens.
- Focused contract suite and `node --check` pass.

## Delivery boundary

Evidence is in `v2/evidence/accounts-authority-runtime-entry-1107/`. No push,
merge, publish, daemon restart, tmux lifecycle action, or foreign module edit.
