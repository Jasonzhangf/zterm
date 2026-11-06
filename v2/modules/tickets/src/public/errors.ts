import type { OperationRef } from '../domain/write-operation.ts'

export type TicketErrorCode =
  | 'TICKET_SCOPE_FORBIDDEN'
  | 'TICKET_REPORT_DELEGATION_FORBIDDEN'
  | 'PROVIDER_UNAUTHORIZED'
  | 'PROVIDER_FORBIDDEN'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_VALIDATION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'WRITE_OUTCOME_UNKNOWN'
  | 'OPERATION_CONFLICT'
  | 'OPERATION_SUPERSEDED'
  | 'BINDING_CONFLICT'
  | 'INVALID_REQUEST'

export type RetryDisposition =
  | 'none'
  | 'credential-repair'
  | 'query'
  | 'manual-reconciliation'
  | 'await-current-attempt'

export interface TicketErrorOptions {
  operationRef?: OperationRef
  providerStatus?: number
  retryDisposition?: RetryDisposition
  /**
   * Original cause, preserved along the unified error port. When the service
   * maps a transport failure to a fixed code, the caller can still reach the
   * underlying reason through `error.cause` instead of losing it.
   */
  cause?: unknown
  details?: Readonly<Record<string, unknown>>
}

export class TicketError extends Error {
  override readonly name = 'TicketError'
  readonly code: TicketErrorCode
  readonly owningModule = 'tickets'
  readonly operationRef?: OperationRef
  readonly providerStatus?: number
  readonly retryDisposition: RetryDisposition
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: TicketErrorCode, message?: string, options: TicketErrorOptions = {}) {
    super(message ?? code, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.operationRef = options.operationRef
    this.providerStatus = options.providerStatus
    this.retryDisposition = options.retryDisposition ?? 'none'
    this.details = options.details
  }
}
