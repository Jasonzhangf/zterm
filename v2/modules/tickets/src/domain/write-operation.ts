import type { TicketErrorCode } from '../public/errors.ts'

/**
 * The complete identity of a write operation. Receipts, reconciliation, and
 * result reads always use this triple, never a bare operationId.
 *
 * The narrowest uniqueness scope is (workspaceId, actorAccountId, operationId).
 * The actorAccountId is the original initiating account and never the current
 * reconciler.
 */
export interface OperationRef {
  workspaceId: string
  actorAccountId: string
  operationId: string
}

export type WriteOperationState = 'pending' | 'succeeded' | 'failed' | 'unknown' | 'superseded'
export type WriteOperationKind = 'create' | 'appendReport' | 'close' | 'reopen'
export type Resolution = 'none' | 'auto-verified' | 'manually-verified'
export type SuccessSource = 'provider' | 'manual'

export interface WriteOperation {
  operationRef: OperationRef
  bindingId?: string
  kind: WriteOperationKind
  /** Canonical typed requested fields. Compared for same-ref conflict detection. */
  request: unknown
  /**
   * Fixed provider identity captured when the operation was accepted. A later
   * workspace mapping change must not retarget a pending/unknown operation.
   */
  providerInstanceId?: string
  externalProjectId?: number
  state: WriteOperationState
  externalTaskId?: number
  externalCommentId?: number
  intentVersion?: number
  observedAt?: number
  errorCode?: TicketErrorCode
  errorMessage?: string
  /**
   * Original transport cause summary, preserved along the unified error port.
   * Stored as text so it survives JSON persistence without retaining objects
   * that may carry secrets.
   */
  errorCause?: string
  resolution: Resolution
  successSource?: SuccessSource
  verifiedBy?: string
  verifiedAt?: number
  evidenceRef?: string
  executionLeaseOwner?: string
  executionLeaseUntil?: number
}

export function operationRefKey(ref: OperationRef): string {
  return `${ref.workspaceId}\u0000${ref.actorAccountId}\u0000${ref.operationId}`
}

export function refsEqual(a: OperationRef, b: OperationRef): boolean {
  return a.workspaceId === b.workspaceId && a.actorAccountId === b.actorAccountId && a.operationId === b.operationId
}

/** Deterministic serialization so request equality does not depend on key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

export function canonicalRequest(request: unknown): string {
  return stableStringify(request)
}
