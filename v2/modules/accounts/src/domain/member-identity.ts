import { ALL_WORKSPACES } from './authorization.ts'
import { AccountsError } from '../public/errors.ts'

/**
 * Accounts-owned designation of the workspace member that represents an
 * account. It is an explicit administrative association, not proof that the
 * account is a real-world person. It carries no credentials or session copies.
 *
 * The logical key is `(accountId, workspaceId)`.
 */
export interface AccountMemberIdentityBinding {
  readonly accountId: string
  readonly workspaceId: string
  readonly memberId: string
  readonly state: 'active' | 'revoked'
  readonly revision: number
}

export interface SetMemberIdentityStoreInput {
  readonly accountId: string
  readonly workspaceId: string
  readonly memberId: string
  /** `null` creates a new binding; a positive integer replaces an existing one. */
  readonly expectedRevision: number | null
}

export interface RevokeMemberIdentityStoreInput {
  readonly accountId: string
  readonly workspaceId: string
  readonly expectedRevision: number
}

export function requireConcreteWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AccountsError('INVALID_REQUEST', 400, 'workspaceId must be a non-empty stable ID.')
  }
  const normalized = value.trim()
  if (normalized === ALL_WORKSPACES) {
    throw new AccountsError('INVALID_REQUEST', 400, 'workspaceId must not use the workspace wildcard.')
  }
  return normalized
}

export function requireStableId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AccountsError('INVALID_REQUEST', 400, `${field} must be a non-empty stable ID.`)
  }
  return value.trim()
}

export function requirePositiveRevision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AccountsError('INVALID_REQUEST', 400, `${field} must be a positive safe integer.`)
  }
  return value as number
}

export function normalizeAccountMemberIdentityBinding(
  value: unknown,
): AccountMemberIdentityBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountsError('INVALID_REQUEST', 400, 'Account member identity binding is invalid.')
  }
  const record = value as Partial<AccountMemberIdentityBinding>
  const state = record.state
  if (state !== 'active' && state !== 'revoked') {
    throw new AccountsError('INVALID_REQUEST', 400, 'Account member identity binding is invalid.')
  }
  return {
    accountId: requireStableId(record.accountId, 'accountId'),
    workspaceId: requireConcreteWorkspaceId(record.workspaceId),
    memberId: requireStableId(record.memberId, 'memberId'),
    state,
    revision: requirePositiveRevision(record.revision, 'revision'),
  }
}
