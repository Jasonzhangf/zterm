import type { AuthContext } from '../domain/accounts.ts'
import type { AccountAuthorizationStore } from '../ports/account-authorization-store.ts'
import type { NormalizedAccountAuthorizationGrant } from '../domain/authorization.ts'
import { AccountsError } from '../public/errors.ts'
import type { AuthService } from './auth-service.ts'

export interface ManagementGrant {
  readonly authContext: AuthContext
  readonly grant: NormalizedAccountAuthorizationGrant
}

export function isManagementGrant(
  grant: NormalizedAccountAuthorizationGrant | undefined,
): boolean {
  return Boolean(grant && grant.allWorkspaces && grant.scopes.includes('org:write'))
}

/**
 * The single accounts management rule: a currently relay-verified account that
 * holds an explicit `allWorkspaces` + `org:write` grant.
 */
export async function requireManagementGrant(options: {
  readonly authService: AuthService
  readonly store: AccountAuthorizationStore
  readonly token: string
}): Promise<ManagementGrant> {
  const authContext = await options.authService.verifySession(options.token)
  const grant = await options.store.getGrant(authContext.accountId)
  if (!isManagementGrant(grant)) {
    throw new AccountsError(
      'WORKSPACE_AUTHORIZATION_REQUIRED',
      403,
      'A currently verified all-workspaces org:write management grant is required.',
    )
  }
  return { authContext, grant: grant as NormalizedAccountAuthorizationGrant }
}
