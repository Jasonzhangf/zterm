import { AccountsError } from '../public/errors.ts'

/**
 * Shape of an account record kept by the in-module test double. Account truth
 * itself lives in the V1 relay; this record is not a second authority.
 */
export interface AccountRecord {
  accountId: string
  loginName: string
  displayName: string
  status: 'active' | 'disabled'
  createdAt: string
  updatedAt: string
}

export interface AccountRef {
  accountId: string
  loginName: string
  displayName: string
  status: 'active' | 'disabled'
  createdAt: string
}

/**
 * Verified account context returned after a relay revalidation. The access
 * token is carried as the session id; it is never re-minted locally.
 */
export interface AuthContext {
  sessionId: string
  accountId: string
  loginName: string
  displayName: string
  credentialState: 'active'
  issuedAt: number
  expiresAt: number
}

export function normalizeLoginName(loginName: string): string {
  const normalized = typeof loginName === 'string' ? loginName.trim() : ''
  if (normalized.length === 0) {
    throw new AccountsError('INVALID_REQUEST', 400, undefined, { field: 'loginName' })
  }
  return normalized
}

export function toAccountRef(record: AccountRecord): AccountRef {
  return {
    accountId: record.accountId,
    loginName: record.loginName,
    displayName: record.displayName,
    status: record.status,
    createdAt: record.createdAt,
  }
}
