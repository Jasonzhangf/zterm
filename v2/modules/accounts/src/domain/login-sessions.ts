import { createHash, randomBytes } from 'node:crypto'
import { AccountsError } from '../public/errors.ts'

/**
 * Persisted session shape used by the in-module test double. It holds a digest
 * of the opaque token, never the raw token, so the store cannot be used to
 * recover a live session credential.
 */
export interface LoginSessionRecord {
  sessionId: string
  accountId: string
  tokenDigest: string
  issuedAt: string
  expiresAt: string
  revokedAt?: string
}

export function createOpaqueToken(tokenFactory?: () => string): string {
  const token = tokenFactory ? tokenFactory() : randomBytes(32).toString('base64url')
  if (typeof token !== 'string' || token.length === 0) {
    throw new AccountsError('INVALID_REQUEST', 400, undefined, { field: 'tokenFactory' })
  }
  return token
}

export function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}
