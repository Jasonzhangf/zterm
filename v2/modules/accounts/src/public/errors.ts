/**
 * Canonical accounts error type. There is exactly one copy of this type in the
 * module; every port and service surfaces failures through it.
 *
 * UNSUPPORTED (501) is the explicit declaration of a V1 relay gap. It is used
 * instead of faking registration, remote revocation, or machine enrollment.
 */
export type AccountsErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_MACHINE_REQUEST'
  | 'ACCOUNT_EXISTS'
  | 'INVALID_CREDENTIALS'
  | 'AUTHENTICATION_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'MACHINE_ALREADY_ENROLLED'
  | 'MACHINE_ALREADY_OWNED'
  | 'MACHINE_DEVICE_CONFLICT'
  | 'MACHINE_NOT_FOUND'
  | 'MACHINE_NOT_OWNED'
  | 'MACHINE_REVOKED'
  | 'MACHINE_IDENTITY_UNVERIFIED'
  | 'POSSESSION_INVALID'
  | 'WORKSPACE_AUTHORIZATION_REQUIRED'
  | 'WORKSPACE_FORBIDDEN'
  | 'CROSS_ACCOUNT_ACCESS_DISABLED'
  | 'UNSUPPORTED'
  | 'RELAY_TRANSPORT_ERROR'
  | 'RELAY_SERVICE_ERROR'
  | 'RELAY_PROTOCOL_ERROR'
  | 'RELAY_PERMISSION_DENIED'

export class AccountsError extends Error {
  readonly code: AccountsErrorCode
  readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 501 | 502 | 503
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: AccountsErrorCode,
    status: 400 | 401 | 403 | 404 | 409 | 429 | 501 | 502 | 503,
    message?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message ?? code)
    this.name = 'AccountsError'
    this.code = code
    this.status = status
    this.details = details
  }
}
