// Development stand-in for the accounts verifySession port. It maps an opaque
// bearer token to an immutable AuthContext so routing can authorize by action,
// workspace, and member. Caller input never supplies account identity, and this
// is not an account store.
//
// AuthContext: { accountId, scopes: string[], workspaces: string[] | '*',
//                members?: string[] }
// `members` is optional. Absent means no member-level narrowing; an explicit
// array is a precise allowlist (empty means "no member target"), and `'*'` or
// any malformed value is passed through so the routing service rejects it as an
// undeclared grant rather than silently widening it.

import { ERROR_CODES, fail } from '../../../organization/src/public/typed-error.mjs';

function toMembers(value) {
  if (value === undefined || value === '*') return value;
  if (Array.isArray(value)) return Object.freeze([...value]);
  return value;
}

export function createRoutingDevAuth({ accounts } = {}) {
  const table = new Map();
  for (const [token, account] of Object.entries(accounts ?? {})) {
    table.set(token, Object.freeze({
      accountId: account.accountId,
      scopes: Object.freeze([...(account.scopes ?? [])]),
      workspaces: account.workspaces === '*'
        ? '*'
        : Object.freeze([...(account.workspaces ?? [])]),
      members: toMembers(account.members),
    }));
  }

  return Object.freeze({
    async verify(token) {
      if (typeof token !== 'string' || token.length === 0) {
        fail(ERROR_CODES.UNAUTHENTICATED, 'missing auth token', { owningModule: 'accounts' });
      }
      const context = table.get(token);
      if (!context) {
        fail(ERROR_CODES.UNAUTHENTICATED, 'unverified auth token', { owningModule: 'accounts' });
      }
      return context;
    },
  });
}
