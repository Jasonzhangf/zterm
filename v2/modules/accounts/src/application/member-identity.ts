import {
  requireConcreteWorkspaceId,
  requirePositiveRevision,
  requireStableId,
  type AccountMemberIdentityBinding,
} from '../domain/member-identity.ts'
import type { AccountAuthorizationStore } from '../ports/account-authorization-store.ts'
import type { MemberIdentityDirectoryPort } from '../ports/member-identity-directory.ts'
import { AccountsError } from '../public/errors.ts'
import type { AuthService } from './auth-service.ts'
import { requireManagementGrant } from './management-authority.ts'

export interface SetMemberIdentityInput {
  readonly token: string
  readonly workspaceId: string
  readonly memberId: string
  readonly expectedRevision: number | null
}

export interface RevokeMemberIdentityInput {
  readonly token: string
  readonly workspaceId: string
  readonly expectedRevision: number
}

/**
 * Structurally usable as tickets' VerifiedAuthContext. `sessionId` carries the
 * bearer internally and must never be serialized into a response or evidence.
 */
export interface ResolvedWorkspaceActor {
  readonly sessionId: string
  readonly accountId: string
  readonly workspaceId: string
  readonly memberId: string
  readonly credentialState: 'active'
}

export interface ResolveWorkspaceActorInput {
  readonly token: string
  readonly workspaceId: string
}

export interface MemberIdentityServiceOptions {
  readonly authService: AuthService
  readonly store: AccountAuthorizationStore
  readonly members: MemberIdentityDirectoryPort
}

function workspaceAllowed(
  grant: { readonly allWorkspaces: boolean; readonly workspaceIds: readonly string[] },
  workspaceId: string,
): boolean {
  return grant.allWorkspaces || grant.workspaceIds.includes(workspaceId)
}

function memberAllowlisted(
  grant: { readonly memberIds: readonly string[] },
  memberId: string,
): boolean {
  // A non-empty member list is an explicit restriction. An empty list means the
  // grant does not narrow membership; it is never used as identity truth.
  return grant.memberIds.length === 0 || grant.memberIds.includes(memberId)
}

export class MemberIdentityService {
  readonly #authService: AuthService
  readonly #store: AccountAuthorizationStore
  readonly #members: MemberIdentityDirectoryPort

  constructor(options: MemberIdentityServiceOptions) {
    this.#authService = options.authService
    this.#store = options.store
    this.#members = options.members
  }

  async setMemberIdentity(input: SetMemberIdentityInput): Promise<AccountMemberIdentityBinding> {
    if (!input || typeof input !== 'object') {
      throw new AccountsError('INVALID_REQUEST', 400, 'setMemberIdentity input is required.')
    }
    const { authContext, grant } = await requireManagementGrant({
      authService: this.#authService,
      store: this.#store,
      token: input.token,
    })
    const workspaceId = requireConcreteWorkspaceId(input.workspaceId)
    const memberId = requireStableId(input.memberId, 'memberId')
    const expectedRevision = input.expectedRevision
    if (expectedRevision !== null) {
      requirePositiveRevision(expectedRevision, 'expectedRevision')
    }
    if (!workspaceAllowed(grant, workspaceId)) {
      throw new AccountsError(
        'WORKSPACE_FORBIDDEN',
        403,
        'The account is not authorized for this workspace.',
        { workspaceId },
      )
    }
    if (!memberAllowlisted(grant, memberId)) {
      throw new AccountsError(
        'WORKSPACE_FORBIDDEN',
        403,
        'The member is excluded by the account member allowlist.',
        { memberId },
      )
    }
    const member = await this.#members.getMember(memberId)
    if (!member || member.memberId !== memberId || member.workspaceId !== workspaceId) {
      throw new AccountsError(
        'ACCOUNT_MEMBER_IDENTITY_INVALID',
        403,
        'The member does not belong to the requested workspace.',
        { memberId, workspaceId },
      )
    }
    return await this.#store.putMemberIdentity({
      accountId: authContext.accountId,
      workspaceId,
      memberId,
      expectedRevision,
    })
  }

  async revokeMemberIdentity(
    input: RevokeMemberIdentityInput,
  ): Promise<AccountMemberIdentityBinding> {
    if (!input || typeof input !== 'object') {
      throw new AccountsError('INVALID_REQUEST', 400, 'revokeMemberIdentity input is required.')
    }
    const { authContext } = await requireManagementGrant({
      authService: this.#authService,
      store: this.#store,
      token: input.token,
    })
    const workspaceId = requireConcreteWorkspaceId(input.workspaceId)
    const expectedRevision = requirePositiveRevision(input.expectedRevision, 'expectedRevision')
    // Revocation intentionally does not consult organization so a deleted
    // member can still be released.
    return await this.#store.revokeMemberIdentity({
      accountId: authContext.accountId,
      workspaceId,
      expectedRevision,
    })
  }

  async resolveWorkspaceActor(
    input: ResolveWorkspaceActorInput,
  ): Promise<ResolvedWorkspaceActor> {
    if (!input || typeof input !== 'object') {
      throw new AccountsError('INVALID_REQUEST', 400, 'resolveWorkspaceActor input is required.')
    }
    const workspaceId = requireConcreteWorkspaceId(input.workspaceId)
    const authContext = await this.#authService.verifySession(input.token)
    const grant = await this.#store.getGrant(authContext.accountId)
    if (!grant) {
      throw new AccountsError(
        'WORKSPACE_AUTHORIZATION_REQUIRED',
        403,
        'No workspace authorization grant exists for this account.',
      )
    }
    if (!workspaceAllowed(grant, workspaceId)) {
      throw new AccountsError(
        'WORKSPACE_FORBIDDEN',
        403,
        'The account is not authorized for this workspace.',
        { workspaceId },
      )
    }
    const binding = await this.#store.getMemberIdentity(authContext.accountId, workspaceId)
    if (!binding) {
      throw new AccountsError(
        'ACCOUNT_MEMBER_IDENTITY_REQUIRED',
        403,
        'No explicit account/member identity binding exists for this workspace.',
        { workspaceId },
      )
    }
    if (binding.state !== 'active') {
      throw new AccountsError(
        'ACCOUNT_MEMBER_IDENTITY_REVOKED',
        403,
        'The account/member identity binding is revoked.',
        { workspaceId },
      )
    }
    if (!memberAllowlisted(grant, binding.memberId)) {
      throw new AccountsError(
        'WORKSPACE_FORBIDDEN',
        403,
        'The member is excluded by the account member allowlist.',
        { memberId: binding.memberId },
      )
    }
    const owner = await this.#store.findActiveMemberIdentityByMember(binding.memberId)
    if (!owner || owner.accountId !== authContext.accountId || owner.workspaceId !== workspaceId) {
      throw new AccountsError(
        'ACCOUNT_MEMBER_IDENTITY_CONFLICT',
        409,
        'The member has another active account owner.',
        { memberId: binding.memberId },
      )
    }
    const member = await this.#members.getMember(binding.memberId)
    if (!member || member.memberId !== binding.memberId || member.workspaceId !== workspaceId) {
      throw new AccountsError(
        'ACCOUNT_MEMBER_IDENTITY_INVALID',
        403,
        'The member does not belong to the requested workspace.',
        { memberId: binding.memberId, workspaceId },
      )
    }
    return {
      sessionId: input.token,
      accountId: authContext.accountId,
      workspaceId,
      memberId: binding.memberId,
      credentialState: 'active',
    }
  }
}

export function createMemberIdentityService(
  options: MemberIdentityServiceOptions,
): MemberIdentityService {
  return new MemberIdentityService(options)
}
