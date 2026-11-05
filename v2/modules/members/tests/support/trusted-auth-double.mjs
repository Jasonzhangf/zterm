// Members-local TEST DOUBLE for the accounts verifySession port. It is not a
// production account store and must not be used outside members tests/evidence.
// The real accounts module is expected to return the same AuthContext shape
// ({ accountId, scopes, workspaces, members }); organization
// createDevVerifiedAuth does not emit workspaces yet, so members uses this
// double to exercise scope, workspace, and member allowlist authorization with
// positive and negative cases.

import { ERROR_CODES, fail } from '../../../organization/src/public/typed-error.mjs';

export function createTrustedAuthDouble({ accounts } = {}) {
  const table = new Map();
  for (const [token, context] of Object.entries(accounts ?? {})) {
    const members = context.members === undefined
      ? undefined
      : context.members === '*' || !Array.isArray(context.members)
        ? context.members
        : Object.freeze([...context.members]);
    table.set(token, Object.freeze({
      accountId: context.accountId,
      scopes: Object.freeze([...(context.scopes ?? [])]),
      workspaces: context.workspaces === '*' ? '*' : Object.freeze([...(context.workspaces ?? [])]),
      members,
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
