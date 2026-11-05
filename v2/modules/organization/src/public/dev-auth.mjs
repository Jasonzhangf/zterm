// Development stand-in for the accounts verifySession port. It only maps an
// opaque bearer token to a pre-registered, immutable AuthContext. The caller can
// never supply account identity directly, and this is not an account store.

import { ERROR_CODES, fail } from './typed-error.mjs';

function freezeList(value) {
  return value === undefined ? undefined : Object.freeze([...value]);
}

export function createDevVerifiedAuth({ accounts } = {}) {
  const table = new Map();
  if (accounts) {
    for (const [token, context] of Object.entries(accounts)) {
      table.set(token, Object.freeze({
        accountId: context.accountId,
        scopes: Object.freeze([...(context.scopes ?? [])]),
        workspaces: context.workspaces === '*' ? '*' : freezeList(context.workspaces),
        members: freezeList(context.members),
      }));
    }
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
