import type { TicketErrorCode } from '../public/errors.ts'
import type { TicketCategory } from './ticket-binding.ts'
import type { OperationRef, Resolution, SuccessSource, WriteOperationKind, WriteOperationState } from './write-operation.ts'

export type TicketFreshness = 'fresh' | 'stale' | 'best-effort' | 'unavailable'
export type OperationFreshness = 'fresh' | 'stale' | 'unavailable' | 'unknown'

export interface ErrorRef {
  code: TicketErrorCode
  message?: string
  /**
   * Original transport cause summary carried from the unified error port. It is
   * text only; never a token or full authorization header.
   */
  cause?: string
}

export interface TicketView {
  externalTaskId: number
  title: string
  description?: string
  priority: number
  done: boolean
  doneAt?: string
  providerProjectId?: number
}

export interface TicketBindingView {
  bindingId: string
  workspaceId: string
  goalId: string
  ownerMemberId: string
  category: TicketCategory
  externalTaskId: number
  providerInstanceId: string
}

export interface TicketObservation {
  binding: TicketBindingView
  ticket?: TicketView
  providerObservedAt: number
  freshness: 'fresh' | 'stale' | 'unavailable'
  errorRef?: ErrorRef
}

export interface OperationView {
  operationRef: OperationRef
  actorMemberId?: string
  bindingId?: string
  kind: WriteOperationKind
  state: WriteOperationState
  externalTaskId?: number
  externalCommentId?: number
  intentVersion?: number
  observedAt?: number
  resolution: Resolution
  successSource?: SuccessSource
  freshness: OperationFreshness
  errorRef?: ErrorRef
  retryDisposition: 'none' | 'credential-repair' | 'query' | 'manual-reconciliation' | 'await-current-attempt'
  reconciliationAllowed: boolean
}

export interface WriteOperationResult {
  operation: OperationView
}

export interface CreateTicketResult {
  operation: OperationView
  binding?: TicketBindingView
  ticket?: TicketObservation
}

export interface TicketListObservation {
  items: TicketObservation[]
  totalKnown?: number
  observationStartedAt: number
  observationEndedAt: number
  freshness: TicketFreshness
  nextCursor?: string
  errorRef?: ErrorRef
}

export interface GoalTicketTopFiveObservation {
  goalId: string
  items: TicketObservation[]
  freshness: 'fresh' | 'stale' | 'unavailable'
  observedAt: number
  nextCursor?: string
  errorRef?: ErrorRef
}

export interface PendingWriteObservation {
  operation: OperationView
  canReconcile: boolean
}
