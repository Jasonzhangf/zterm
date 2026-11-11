import type {
  AccountAuthorizationGrantInput,
  NormalizedAccountAuthorizationGrant,
} from '../domain/authorization.ts'
import type {
  AccountMemberIdentityBinding,
  RevokeMemberIdentityStoreInput,
  SetMemberIdentityStoreInput,
} from '../domain/member-identity.ts'

/**
 * Persistent accounts-owned policy store. It stores one grant per stable
 * account ID and is the explicit management entry for authorization records.
 * It also owns the explicit account/member identity collection keyed by
 * `(accountId, workspaceId)` and serializes all identity mutations with the
 * grant and generation counter records in one file.
 */
export interface AccountAuthorizationStore {
  getGrant(accountId: string): Promise<NormalizedAccountAuthorizationGrant | undefined>
  putGrant(grant: AccountAuthorizationGrantInput): Promise<NormalizedAccountAuthorizationGrant>
  /**
   * Deletes the grant and, in the same serialized mutation, revokes every
   * active identity record for that account.
   */
  deleteGrant(
    accountId: string,
    expectedGeneration?: number,
  ): Promise<NormalizedAccountAuthorizationGrant | undefined>

  getMemberIdentity(
    accountId: string,
    workspaceId: string,
  ): Promise<AccountMemberIdentityBinding | undefined>
  /**
   * Creates, replaces, or reactivates the account/workspace binding. The store
   * enforces the revision and both uniqueness constraints atomically.
   */
  putMemberIdentity(
    input: SetMemberIdentityStoreInput,
  ): Promise<AccountMemberIdentityBinding>
  /**
   * Marks the current binding revoked and increments its revision. It does not
   * consult organization, so a deleted member can still be released.
   */
  revokeMemberIdentity(
    input: RevokeMemberIdentityStoreInput,
  ): Promise<AccountMemberIdentityBinding>
  /**
   * Returns the single active binding that owns a stable member ID, if any.
   */
  findActiveMemberIdentityByMember(
    memberId: string,
  ): Promise<AccountMemberIdentityBinding | undefined>
}
