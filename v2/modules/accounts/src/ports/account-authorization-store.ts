import type { AccountAuthorizationGrant } from '../domain/authorization.ts'

/**
 * Persistent accounts-owned policy store. It stores one grant per stable
 * account ID and is the explicit management entry for authorization records.
 */
export interface AccountAuthorizationStore {
  getGrant(accountId: string): Promise<AccountAuthorizationGrant | undefined>
  putGrant(grant: AccountAuthorizationGrant): Promise<void>
  deleteGrant(accountId: string): Promise<void>
}
