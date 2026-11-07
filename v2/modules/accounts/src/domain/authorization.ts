import { AccountsError } from '../public/errors.ts'

export const ALL_WORKSPACES = '*' as const

/**
 * Accounts-owned authorization policy. The account ID is the stable subject;
 * workspace and member IDs are stable resource references. The record never
 * contains credentials, relay session copies, or machine connection tokens.
 */
export interface AccountAuthorizationGrant {
  readonly accountId: string
  readonly scopes: readonly string[]
  readonly allWorkspaces: boolean
  readonly workspaceIds: readonly string[]
  readonly memberIds: readonly string[]
  readonly updatedAt: string
}

/**
 * Authorization context consumed by control-plane owners. It is deliberately
 * separate from AuthContext, which proves only relay identity and session
 * validity.
 */
export interface WorkspaceAuthorizationContext {
  readonly accountId: string
  readonly scopes: readonly string[]
  readonly workspaces?: readonly string[] | typeof ALL_WORKSPACES
  readonly members?: readonly string[]
}

function stableId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AccountsError('INVALID_REQUEST', 400, `${field} must be a non-empty stable ID.`)
  }
  const normalized = value.trim()
  if (normalized === ALL_WORKSPACES) {
    throw new AccountsError('INVALID_REQUEST', 400, `${field} must not use the workspace wildcard.`)
  }
  return normalized
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AccountsError('INVALID_REQUEST', 400, `${field} must be an array.`)
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new AccountsError('INVALID_REQUEST', 400, `${field} must contain non-empty strings.`)
    }
    const normalized = entry.trim()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

export function normalizeAccountAuthorizationGrant(
  grant: AccountAuthorizationGrant,
): AccountAuthorizationGrant {
  if (!grant || typeof grant !== 'object') {
    throw new AccountsError('INVALID_REQUEST', 400, 'Account authorization grant is required.')
  }
  if (typeof grant.allWorkspaces !== 'boolean') {
    throw new AccountsError('INVALID_REQUEST', 400, 'allWorkspaces must be a boolean.')
  }
  const updatedAt = typeof grant.updatedAt === 'string' ? grant.updatedAt.trim() : ''
  if (updatedAt.length === 0) {
    throw new AccountsError('INVALID_REQUEST', 400, 'updatedAt must be a non-empty timestamp.')
  }
  return {
    accountId: stableId(grant.accountId, 'accountId'),
    scopes: stringList(grant.scopes, 'scopes'),
    allWorkspaces: grant.allWorkspaces,
    workspaceIds: stringList(grant.workspaceIds, 'workspaceIds'),
    memberIds: stringList(grant.memberIds, 'memberIds'),
    updatedAt,
  }
}

export function toWorkspaceAuthorizationContext(
  grant: AccountAuthorizationGrant,
): WorkspaceAuthorizationContext {
  const normalized = normalizeAccountAuthorizationGrant(grant)
  return {
    accountId: normalized.accountId,
    scopes: [...normalized.scopes],
    workspaces: normalized.allWorkspaces
      ? ALL_WORKSPACES
      : [...normalized.workspaceIds],
    ...(normalized.memberIds.length > 0
      ? { members: [...normalized.memberIds] }
      : {}),
  }
}
