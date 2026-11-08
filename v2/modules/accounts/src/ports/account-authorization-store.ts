import type {
  AccountAuthorizationGrantInput,
  NormalizedAccountAuthorizationGrant,
} from '../domain/authorization.ts'

/**
 * Persistent accounts-owned policy store. It stores one grant per stable
 * account ID and is the explicit management entry for authorization records.
 */
export interface AccountAuthorizationStore {
  getGrant(accountId: string): Promise<NormalizedAccountAuthorizationGrant | undefined>
  putGrant(grant: AccountAuthorizationGrantInput): Promise<NormalizedAccountAuthorizationGrant>
  deleteGrant(
    accountId: string,
    expectedGeneration?: number,
  ): Promise<NormalizedAccountAuthorizationGrant | undefined>
}
