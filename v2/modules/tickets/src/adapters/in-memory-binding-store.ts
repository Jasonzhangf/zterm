import type { TicketBinding, WorkspaceProviderBinding } from '../domain/ticket-binding.ts'
import type { ProviderInstance } from '../domain/provider-instance.ts'
import type {
  OperationRef,
  WriteOperation,
  WriteOperationState,
} from '../domain/write-operation.ts'
import { operationRefKey } from '../domain/write-operation.ts'
import { TicketError } from '../public/errors.ts'
import type {
  BindingFilter,
  BindingStorePort,
  CommitWriteResult,
  CreateOperationResult,
  Lease,
  OperationFilter,
  PendingWriteScope,
} from '../ports/binding-store.ts'

function externalKey(providerInstanceId: string, externalTaskId: number): string {
  return `${providerInstanceId}\u0000${externalTaskId}`
}

function memberKey(memberId: string, providerInstanceId: string): string {
  return `${memberId}\u0000${providerInstanceId}`
}

function commentKey(providerInstanceId: string, externalCommentId: number): string {
  return `${providerInstanceId}\u0000${externalCommentId}`
}

/**
 * Hermetic store used by contract tests and single-process callers. It follows
 * the same port semantics as SqliteBindingStore without touching disk.
 */
export class InMemoryBindingStore implements BindingStorePort {
  readonly #operations = new Map<string, WriteOperation>()
  readonly #bindings = new Map<string, TicketBinding>()
  readonly #external = new Map<string, TicketBinding>()
  readonly #workspaceProviders = new Map<string, WorkspaceProviderBinding>()
  readonly #providerInstances = new Map<string, ProviderInstance>()
  readonly #memberMappings = new Map<string, { providerAssigneeId?: number }>()
  readonly #intentVersions = new Map<string, number>()
  readonly #commentClaims = new Map<string, OperationRef>()
  #bindingSeq = 0

  async getOperation(ref: OperationRef): Promise<WriteOperation | undefined> {
    return this.#operations.get(operationRefKey(ref))
  }

  async recoverExpiredPending(ref: OperationRef, now: number): Promise<WriteOperation | undefined> {
    const current = this.#operations.get(operationRefKey(ref))
    if (!current || current.state !== 'pending') return current
    if ((current.executionLeaseUntil ?? 0) > now) return current
    const recovered: WriteOperation = {
      ...current,
      state: 'unknown',
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
      errorMessage: 'execution lease expired before the local state commit; verify the remote result manually',
      observedAt: now,
    }
    this.#operations.set(operationRefKey(ref), recovered)
    return recovered
  }

  async putOperation(operation: WriteOperation): Promise<void> {
    this.#putOperation(operation)
  }

  async createOperationIfAbsent(operation: WriteOperation, lease: Lease): Promise<CreateOperationResult> {
    const key = operationRefKey(operation.operationRef)
    const existing = this.#operations.get(key)
    if (existing) return { created: false, operation: existing }
    const withLease: WriteOperation = {
      ...operation,
      executionLeaseOwner: lease.owner,
      executionLeaseUntil: lease.until,
    }
    this.#operations.set(key, withLease)
    return { created: true, operation: withLease }
  }

  async beginStateOperation(operation: WriteOperation, lease: Lease): Promise<CreateOperationResult> {
    const key = operationRefKey(operation.operationRef)
    const existing = this.#operations.get(key)
    if (existing) return { created: false, operation: existing }
    if (!operation.bindingId) throw new TicketError('BINDING_CONFLICT', 'state operation without bindingId')
    const binding = this.#bindings.get(operation.bindingId)
    if (!binding) return { created: false, operation }

    const intentVersion = Math.max(this.#intentVersions.get(binding.bindingId) ?? 0, binding.stateIntentVersion) + 1
    this.#intentVersions.set(binding.bindingId, intentVersion)
    for (const [candidateKey, candidate] of this.#operations) {
      if (candidate.bindingId !== binding.bindingId) continue
      if (candidate.kind !== 'close' && candidate.kind !== 'reopen') continue
      if (candidate.state !== 'pending' && candidate.state !== 'unknown') continue
      this.#operations.set(candidateKey, {
        ...candidate,
        state: 'superseded',
        errorCode: 'OPERATION_SUPERSEDED',
        errorMessage: 'superseded by a newer state intent',
      })
    }
    this.#bindings.set(binding.bindingId, { ...binding, stateIntentVersion: intentVersion })
    const withLease: WriteOperation = {
      ...operation,
      intentVersion,
      executionLeaseOwner: lease.owner,
      executionLeaseUntil: lease.until,
    }
    this.#operations.set(key, withLease)
    return { created: true, operation: withLease }
  }

  async listOperations(filter: OperationFilter): Promise<WriteOperation[]> {
    return [...this.#operations.values()].filter((operation) => {
      if (operation.operationRef.workspaceId !== filter.workspaceId) return false
      if (filter.actorAccountId && operation.operationRef.actorAccountId !== filter.actorAccountId) return false
      if (filter.states && !filter.states.includes(operation.state)) return false
      if (filter.kinds && !filter.kinds.includes(operation.kind)) return false
      return true
    })
  }

  async listPendingWrites(filter: PendingWriteScope): Promise<WriteOperation[]> {
    return [...this.#operations.values()].filter((operation) => {
      if (operation.operationRef.workspaceId !== filter.workspaceId) return false
      if (filter.actorAccountId && operation.operationRef.actorAccountId !== filter.actorAccountId) return false
      if (filter.states && !filter.states.includes(operation.state)) return false
      if (filter.kinds && !filter.kinds.includes(operation.kind)) return false
      return true
    })
  }

  async getBinding(bindingId: string): Promise<TicketBinding | undefined> {
    return this.#bindings.get(bindingId)
  }

  async getBindingByExternal(providerInstanceId: string, externalTaskId: number): Promise<TicketBinding | undefined> {
    return this.#external.get(externalKey(providerInstanceId, externalTaskId))
  }

  async getOperationByExternalComment(
    providerInstanceId: string,
    externalCommentId: number,
  ): Promise<WriteOperation | undefined> {
    const ref = this.#commentClaims.get(commentKey(providerInstanceId, externalCommentId))
    return ref ? this.#operations.get(operationRefKey(ref)) : undefined
  }

  async listBindings(filter: BindingFilter): Promise<TicketBinding[]> {
    return [...this.#bindings.values()].filter((binding) => {
      if (binding.workspaceId !== filter.workspaceId) return false
      if (filter.goalId && binding.goalId !== filter.goalId) return false
      if (filter.ownerMemberId && binding.ownerMemberId !== filter.ownerMemberId) return false
      return true
    })
  }

  async putBinding(binding: TicketBinding): Promise<void> {
    this.#putBinding(binding)
  }

  async allocateBindingId(): Promise<string> {
    let bindingId: string
    do {
      this.#bindingSeq += 1
      bindingId = `binding-${this.#bindingSeq}`
    } while (this.#bindings.has(bindingId))
    return bindingId
  }

  async nextIntentVersion(bindingId: string): Promise<number> {
    const binding = this.#bindings.get(bindingId)
    if (!binding) throw new TicketError('BINDING_CONFLICT', 'binding not found for intent version')
    const next = Math.max(this.#intentVersions.get(bindingId) ?? 0, binding.stateIntentVersion) + 1
    this.#intentVersions.set(bindingId, next)
    this.#bindings.set(bindingId, { ...binding, stateIntentVersion: next })
    return next
  }

  async getWorkspaceProvider(workspaceId: string): Promise<WorkspaceProviderBinding | undefined> {
    return this.#workspaceProviders.get(workspaceId)
  }

  async putWorkspaceProvider(binding: WorkspaceProviderBinding): Promise<void> {
    this.#workspaceProviders.set(binding.workspaceId, binding)
  }

  async getProviderInstance(providerInstanceId: string): Promise<ProviderInstance | undefined> {
    return this.#providerInstances.get(providerInstanceId)
  }

  async putProviderInstance(provider: ProviderInstance): Promise<void> {
    this.#providerInstances.set(provider.providerInstanceId, provider)
  }

  async getMemberMapping(
    memberId: string,
    providerInstanceId: string,
  ): Promise<{ providerAssigneeId?: number } | undefined> {
    return this.#memberMappings.get(memberKey(memberId, providerInstanceId))
  }

  async commitWriteSuccess(operation: WriteOperation, binding?: TicketBinding): Promise<CommitWriteResult> {
    const key = operationRefKey(operation.operationRef)
    const existing = this.#operations.get(key)
    if (!existing) return { committed: false, operation: undefined, conflict: 'operation-state' }
    if (existing.state === 'superseded') {
      return { committed: false, operation: existing, conflict: 'intent-superseded' }
    }
    if (existing.state !== 'pending' && existing.state !== 'unknown') {
      return { committed: false, operation: existing, conflict: 'operation-state' }
    }
    if (operation.intentVersion !== undefined && operation.bindingId) {
      const currentBinding = this.#bindings.get(operation.bindingId)
      const currentIntent = Math.max(
        this.#intentVersions.get(operation.bindingId) ?? 0,
        currentBinding?.stateIntentVersion ?? 0,
      )
      if (currentIntent !== operation.intentVersion) {
        return { committed: false, operation: existing, conflict: 'intent-superseded' }
      }
    }
    if (binding) {
      const claimed = this.#external.get(externalKey(binding.providerInstanceId, binding.externalTaskId))
      const existingBinding = this.#bindings.get(binding.bindingId)
      if (operation.kind === 'create') {
        if (existingBinding || (claimed && claimed.bindingId !== binding.bindingId)) {
          return { committed: false, operation: existing, conflict: 'binding-conflict' }
        }
      } else if (claimed && claimed.bindingId !== binding.bindingId) {
        return { committed: false, operation: existing, conflict: 'binding-conflict' }
      }
      this.#putBinding(binding)
    }
    this.#putOperation(operation)
    return { committed: true, operation }
  }

  async markOperation(operation: WriteOperation): Promise<void> {
    this.#putOperation(operation)
  }

  async transitionOperation(
    ref: OperationRef,
    expected: { states?: WriteOperationState[]; intentVersion?: number },
    next: WriteOperation,
  ): Promise<{ ok: boolean; current: WriteOperation | undefined }> {
    const key = operationRefKey(ref)
    const current = this.#operations.get(key)
    if (!current) return { ok: false, current: undefined }
    if (expected.states && !expected.states.includes(current.state)) return { ok: false, current }
    if (expected.intentVersion !== undefined && current.intentVersion !== expected.intentVersion) {
      return { ok: false, current }
    }
    this.#operations.set(key, next)
    return { ok: true, current: next }
  }

  async claimComment(
    ref: OperationRef,
    bindingId: string,
    externalCommentId: number,
    next: WriteOperation,
  ): Promise<{ ok: boolean; current: WriteOperation | undefined; conflicting?: OperationRef }> {
    const key = operationRefKey(ref)
    const current = this.#operations.get(key)
    if (!current) return { ok: false, current: undefined, conflicting: ref }
    if (current.state !== 'pending' && current.state !== 'unknown') {
      return { ok: false, current, conflicting: ref }
    }
    const binding = this.#bindings.get(bindingId)
    if (!binding) return { ok: false, current, conflicting: ref }
    const claim = this.#commentClaims.get(commentKey(binding.providerInstanceId, externalCommentId))
    if (claim && operationRefKey(claim) !== key) {
      return { ok: false, current, conflicting: claim }
    }
    // Claim uniqueness is provider-scoped via comment_claims(provider, id);
    // a global numeric-id scan would reject the same id from another provider.
    this.#commentClaims.set(commentKey(binding.providerInstanceId, externalCommentId), ref)
    this.#operations.set(key, next)
    return { ok: true, current: next }
  }

  #putOperation(operation: WriteOperation): void {
    this.#operations.set(operationRefKey(operation.operationRef), operation)
  }

  #putBinding(binding: TicketBinding): void {
    const key = externalKey(binding.providerInstanceId, binding.externalTaskId)
    const claimed = this.#external.get(key)
    if (claimed && claimed.bindingId !== binding.bindingId) {
      throw new TicketError('BINDING_CONFLICT', 'external task already bound')
    }
    const previous = this.#bindings.get(binding.bindingId)
    if (previous) {
      const previousKey = externalKey(previous.providerInstanceId, previous.externalTaskId)
      if (previousKey !== key) this.#external.delete(previousKey)
    }
    this.#bindings.set(binding.bindingId, binding)
    this.#external.set(key, binding)
    const known = this.#intentVersions.get(binding.bindingId) ?? 0
    if (binding.stateIntentVersion > known) {
      this.#intentVersions.set(binding.bindingId, binding.stateIntentVersion)
    }
  }
}
