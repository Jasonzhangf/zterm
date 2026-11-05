import type { TicketBinding, WorkspaceProviderBinding } from '../domain/ticket-binding.ts'
import type { ProviderInstance } from '../domain/provider-instance.ts'
import type { OperationRef, WriteOperation, WriteOperationKind, WriteOperationState } from '../domain/write-operation.ts'

export interface Lease {
  owner: string
  until: number
}

export interface CreateOperationResult {
  created: boolean
  operation: WriteOperation
}

export interface CommitWriteResult {
  committed: boolean
  operation: WriteOperation | undefined
  conflict?: 'operation-state' | 'intent-superseded' | 'binding-conflict' | 'comment-claimed'
}

export interface OperationFilter {
  workspaceId: string
  actorAccountId?: string
  states?: WriteOperationState[]
  kinds?: WriteOperationKind[]
}

export interface BindingFilter {
  workspaceId: string
  goalId?: string
  ownerMemberId?: string
}

export interface PendingWriteScope {
  workspaceId: string
  actorAccountId?: string
  reconcile: boolean
  states?: WriteOperationState[]
  kinds?: WriteOperationKind[]
}

/**
 * Local store for typed bindings, operations, and permission mappings.
 *
 * It is intentionally not a second ticket state database: it never stores a
 * ticket's writable content or done state, only references and the last observed
 * projection required for stale display.
 */
export interface BindingStorePort {
  getOperation(ref: OperationRef): Promise<WriteOperation | undefined>
  /**
   * Read an operation for replay or reconciliation, recovering a `pending`
   * write whose execution lease has already expired to `unknown` so an
   * operator can reconcile it. A live lease is returned unchanged so a running
   * executor is never preempted; recovery never re-sends the write and never
   * guesses its outcome.
   */
  recoverExpiredPending(ref: OperationRef, now: number): Promise<WriteOperation | undefined>
  putOperation(operation: WriteOperation): Promise<void>
  createOperationIfAbsent(operation: WriteOperation, lease: Lease): Promise<CreateOperationResult>
  /**
   * Atomically allocates the next per-binding state intent, supersedes older
   * close/reopen operations for that binding, and inserts the new operation.
   * Other kinds (create/appendReport) must never be superseded here.
   */
  beginStateOperation(operation: WriteOperation, lease: Lease): Promise<CreateOperationResult>
  listOperations(filter: OperationFilter): Promise<WriteOperation[]>
  listPendingWrites(filter: PendingWriteScope): Promise<WriteOperation[]>

  getBinding(bindingId: string): Promise<TicketBinding | undefined>
  getBindingByExternal(providerInstanceId: string, externalTaskId: number): Promise<TicketBinding | undefined>
  getOperationByExternalComment(providerInstanceId: string, externalCommentId: number): Promise<WriteOperation | undefined>
  listBindings(filter: BindingFilter): Promise<TicketBinding[]>
  putBinding(binding: TicketBinding): Promise<void>
  /** Stable, store-owned binding ID so two services sharing a store never collide. */
  allocateBindingId(): Promise<string>
  nextIntentVersion(bindingId: string): Promise<number>

  getWorkspaceProvider(workspaceId: string): Promise<WorkspaceProviderBinding | undefined>
  putWorkspaceProvider(binding: WorkspaceProviderBinding): Promise<void>
  getProviderInstance(providerInstanceId: string): Promise<ProviderInstance | undefined>
  putProviderInstance(provider: ProviderInstance): Promise<void>

  getMemberMapping(memberId: string, providerInstanceId: string): Promise<{ providerAssigneeId?: number } | undefined>

  /**
   * Atomically records a succeeded operation together with its binding (if any).
   * It must not leave a succeeded operation that points at no binding after a
   * create, and must refuse an operation that has already been superseded.
   */
  commitWriteSuccess(operation: WriteOperation, binding?: TicketBinding): Promise<CommitWriteResult>
  markOperation(operation: WriteOperation): Promise<void>
  transitionOperation(
    ref: OperationRef,
    expected: {
      states?: WriteOperationState[]
      intentVersion?: number
    },
    next: WriteOperation,
  ): Promise<{ ok: boolean; current: WriteOperation | undefined }>
  claimComment(
    ref: OperationRef,
    bindingId: string,
    externalCommentId: number,
    next: WriteOperation,
  ): Promise<{ ok: boolean; current: WriteOperation | undefined; conflicting?: OperationRef }>
}
