import { TicketError } from '../public/errors.ts'
import type { RetryDisposition, TicketErrorCode } from '../public/errors.ts'
import type { TicketBinding, TicketCategory } from '../domain/ticket-binding.ts'
import type { ProviderInstance } from '../domain/provider-instance.ts'
import type { VikunjaTask } from '../ports/vikunja-client.ts'
import type {
  GoalTicketTopFiveObservation,
  OperationView,
  PendingWriteObservation,
  TicketBindingView,
  TicketListObservation,
  TicketObservation,
} from '../domain/ticket-view.ts'
import type {
  OperationRef,
  WriteOperation,
  WriteOperationKind,
} from '../domain/write-operation.ts'
import { canonicalRequest } from '../domain/write-operation.ts'
import type { BindingStorePort } from '../ports/binding-store.ts'
import type { CredentialProviderPort } from '../ports/credential-provider.ts'
import type { VikunjaClientPort, VikunjaResult } from '../ports/vikunja-client.ts'
import type {
  TicketAction,
  TicketPublicReaders,
  VerifiedAuthContext,
} from '../ports/ticket-public-readers.ts'

export interface CreateTicketInput {
  operationId: string
  workspaceId: string
  goalId: string
  ownerMemberId: string
  category: TicketCategory
  title: string
  description: string
  priority: number
}

export interface GetTicketInput {
  bindingId: string
}

export interface ListTicketsInput {
  workspaceId: string
  goalId?: string
  status: 'open' | 'closed' | 'all'
  ownerMemberId?: string
  limit: number
  cursor?: string
}

export interface AppendReportInput {
  operationId: string
  bindingId: string
  actorMemberId: string
  executingMemberId?: string
  reportKind: 'status' | 'result' | 'blocker' | 'note'
  body: string
}

export interface MutateTicketStateInput {
  operationId: string
  bindingId: string
}

export interface ConfirmRemoteResultInput {
  operationRef: OperationRef
  candidateExternalTaskId?: number
  candidateExternalCommentId?: number
  providerObservedAt: number
  evidenceRef: string
  attribution: 'operation-produced'
}

export interface TicketServiceOptions {
  store: BindingStorePort
  credentials: CredentialProviderPort
  client: VikunjaClientPort
  readers: TicketPublicReaders
  now?: () => number
}

interface CreateRequest {
  kind: 'create'
  workspaceId: string
  goalId: string
  ownerMemberId: string
  category: TicketCategory
  title: string
  description: string
  priority: number
}

interface AppendReportRequest {
  kind: 'appendReport'
  bindingId: string
  actorMemberId: string
  executingMemberId?: string
  reportKind: 'status' | 'result' | 'blocker' | 'note'
  body: string
}

interface StateRequest {
  kind: 'close' | 'reopen'
  bindingId: string
}

const LEASE_MS = 30_000

interface StatusMapping {
  code: TicketErrorCode
  retry: RetryDisposition
  unknown: boolean
}

function mapWriteStatus(status: number): StatusMapping {
  if (status === 400) return { code: 'PROVIDER_VALIDATION_FAILED', retry: 'none', unknown: false }
  if (status === 401) return { code: 'PROVIDER_UNAUTHORIZED', retry: 'credential-repair', unknown: false }
  if (status === 403) return { code: 'PROVIDER_FORBIDDEN', retry: 'none', unknown: false }
  if (status === 404) return { code: 'PROVIDER_NOT_FOUND', retry: 'none', unknown: false }
  return { code: 'WRITE_OUTCOME_UNKNOWN', retry: 'manual-reconciliation', unknown: true }
}

function retryFor(operation: WriteOperation): OperationView['retryDisposition'] {
  if (operation.state === 'pending') return 'await-current-attempt'
  if (operation.state === 'unknown') return 'manual-reconciliation'
  if (operation.state === 'failed') {
    switch (operation.errorCode) {
      case 'PROVIDER_UNAUTHORIZED':
        return 'credential-repair'
      case 'WRITE_OUTCOME_UNKNOWN':
        return 'manual-reconciliation'
      default:
        return 'none'
    }
  }
  return 'none'
}

function operationFreshness(operation: WriteOperation): OperationView['freshness'] {
  if (operation.state === 'unknown') return 'unknown'
  if (operation.state === 'succeeded') {
    return operation.successSource === 'provider' ? 'fresh' : 'stale'
  }
  if (operation.state === 'superseded') return 'stale'
  return 'unavailable'
}

/** Preserves the original transport reason through the unified error port. */
function causeSummary(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined
  if (typeof cause === 'string') return cause
  if (cause instanceof Error) return cause.message
  try {
    return String(cause)
  } catch {
    return undefined
  }
}

export class TicketService {
  readonly #store: BindingStorePort
  readonly #credentials: CredentialProviderPort
  readonly #client: VikunjaClientPort
  readonly #readers: TicketPublicReaders
  readonly #now: () => number

  constructor(options: TicketServiceOptions) {
    this.#store = options.store
    this.#credentials = options.credentials
    this.#client = options.client
    this.#readers = options.readers
    this.#now = options.now ?? Date.now
  }

  async create(actor: VerifiedAuthContext, input: CreateTicketInput): Promise<import('../domain/ticket-view.ts').CreateTicketResult> {
    const operationRef: OperationRef = {
      workspaceId: input.workspaceId,
      actorAccountId: actor.accountId,
      operationId: input.operationId,
    }
    const request: CreateRequest = {
      kind: 'create',
      workspaceId: input.workspaceId,
      goalId: input.goalId,
      ownerMemberId: input.ownerMemberId,
      category: input.category,
      title: input.title,
      description: input.description,
      priority: input.priority,
    }
    await this.#requireAction(actor, input.workspaceId, 'ticket.create', { goalId: input.goalId })
    await this.#requireGoal(input.workspaceId, input.goalId)
    await this.#requireAssignableMember(actor, input.workspaceId, input.goalId, input.ownerMemberId)

    const existing = await this.#store.recoverExpiredPending(operationRef, this.#now())
    if (existing) {
      this.#assertSameRequest(existing, request, operationRef)
      const binding = existing.bindingId ? await this.#store.getBinding(existing.bindingId) : undefined
      return this.#createResult(existing, binding)
    }

    // Fixed provider identity read once, before the operation is accepted.
    const provider = await this.#store.getWorkspaceProvider(input.workspaceId)
    const now = this.#now()
    const pending: WriteOperation = {
      operationRef,
      kind: 'create',
      request,
      state: 'pending',
      providerInstanceId: provider?.providerInstanceId,
      externalProjectId: provider?.externalProjectId,
      resolution: 'none',
      executionLeaseOwner: `tickets-${input.operationId}`,
      executionLeaseUntil: now + LEASE_MS,
    }
    const cas = await this.#store.createOperationIfAbsent(pending, {
      owner: pending.executionLeaseOwner ?? 'tickets',
      until: pending.executionLeaseUntil ?? now + LEASE_MS,
    })
    if (!cas.created) {
      this.#assertSameRequest(cas.operation, request, operationRef)
      const binding = cas.operation.bindingId ? await this.#store.getBinding(cas.operation.bindingId) : undefined
      return this.#createResult(cas.operation, binding)
    }

    if (!provider) {
      return this.#createResult(await this.#markOperation(operationRef, {
        ...cas.operation,
        state: 'failed',
        errorCode: 'BINDING_CONFLICT',
        errorMessage: 'workspace has no active provider mapping',
        observedAt: now,
      }))
    }
    const providerInstance = await this.#store.getProviderInstance(provider.providerInstanceId)
    if (!providerInstance) {
      return this.#createResult(await this.#markOperation(operationRef, {
        ...cas.operation,
        state: 'failed',
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: `provider instance ${provider.providerInstanceId} is unavailable`,
        observedAt: now,
      }))
    }

    const credential = await this.#credentials.getCredential(provider.providerInstanceId)
    const result = await this.#client.createTask({
      baseUrl: providerInstance.baseUrl,
      token: credential.token,
      projectId: provider.externalProjectId,
      title: input.title,
      description: input.description,
      priority: input.priority,
    })

    if (result.kind === 'transport-error') {
      return this.#createResult(await this.#markUnknown(cas.operation, 'WRITE_OUTCOME_UNKNOWN', result.cause))
    }

    if (result.status === 201 && result.value && typeof result.value.id === 'number') {
      const mapping = await this.#store.getMemberMapping(input.ownerMemberId, provider.providerInstanceId)
      const binding: TicketBinding = {
        bindingId: await this.#store.allocateBindingId(),
        workspaceId: input.workspaceId,
        goalId: input.goalId,
        ownerMemberId: input.ownerMemberId,
        providerInstanceId: provider.providerInstanceId,
        externalProjectId: provider.externalProjectId,
        externalTaskId: result.value.id,
        category: input.category,
        providerAssigneeId: mapping?.providerAssigneeId,
        lastObservedTitle: result.value.title,
        lastObservedPriority: result.value.priority,
        lastObservedDone: result.value.done,
        lastObservedAt: now,
        stateIntentVersion: 0,
      }
      const succeeded: WriteOperation = {
        ...cas.operation,
        bindingId: binding.bindingId,
        state: 'succeeded',
        externalTaskId: result.value.id,
        observedAt: now,
        resolution: 'auto-verified',
        successSource: 'provider',
      }
      const commit = await this.#store.commitWriteSuccess(succeeded, binding)
      if (commit.committed) {
        return this.#createResult(succeeded, binding, this.#observationFromTask(binding, result.value, 'fresh', now))
      }
      return this.#createResult(await this.#markUnknown(cas.operation, 'BINDING_CONFLICT'))
    }

    const mapping = mapWriteStatus(result.status)
    if (mapping.unknown) {
      return this.#createResult(await this.#markUnknown(cas.operation, mapping.code))
    }
    return this.#createResult(await this.#markOperation(operationRef, {
      ...cas.operation,
      state: 'failed',
      errorCode: mapping.code,
      errorMessage: mapping.code,
      observedAt: now,
    }))
  }

  async get(actor: VerifiedAuthContext, input: GetTicketInput): Promise<TicketObservation> {
    const binding = await this.#requireBinding(input.bindingId)
    await this.#requireAction(actor, binding.workspaceId, 'ticket.read', { goalId: binding.goalId, bindingId: binding.bindingId })
    await this.#requireGoal(binding.workspaceId, binding.goalId)

    // Resolve the provider instance fixed on the binding, never the current
    // workspace mapping. A workspace remap must not retarget an existing ticket.
    const provider = await this.#store.getProviderInstance(binding.providerInstanceId)
    if (!provider) {
      return this.#observationFromBinding(binding, this.#hasProjection(binding) ? 'stale' : 'unavailable', this.#now(), {
        code: 'PROVIDER_UNAVAILABLE',
        message: `provider instance ${binding.providerInstanceId} is unavailable`,
      })
    }
    const credential = await this.#credentials.getCredential(binding.providerInstanceId)
    const result = await this.#client.getTask({
      baseUrl: provider.baseUrl,
      token: credential.token,
      taskId: binding.externalTaskId,
    })
    const now = this.#now()

    if (result.kind === 'transport-error') {
      return this.#observationFromBinding(binding, this.#hasProjection(binding) ? 'stale' : 'unavailable', now, {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'provider unreachable',
        cause: causeSummary(result.cause),
      })
    }
    if (result.status === 401) throw new TicketError('PROVIDER_UNAUTHORIZED', undefined, { providerStatus: 401, retryDisposition: 'credential-repair' })
    if (result.status === 403) throw new TicketError('PROVIDER_FORBIDDEN', undefined, { providerStatus: 403 })
    if (result.status === 404) throw new TicketError('PROVIDER_NOT_FOUND', undefined, { providerStatus: 404 })
    if (result.status === 200 && result.value) {
      await this.#store.putBinding({ ...binding, lastObservedTitle: result.value.title, lastObservedPriority: result.value.priority, lastObservedDone: result.value.done, lastObservedAt: now })
      return this.#observationFromTask(binding, result.value, 'fresh', now)
    }
    return this.#observationFromBinding(binding, this.#hasProjection(binding) ? 'stale' : 'unavailable', now, {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'provider returned no task body',
    })
  }

  async list(actor: VerifiedAuthContext, input: ListTicketsInput): Promise<TicketListObservation> {
    await this.#requireAction(actor, input.workspaceId, 'ticket.read', { goalId: input.goalId })
    if (input.goalId) await this.#requireGoal(input.workspaceId, input.goalId)
    return this.#collect(input.workspaceId, input.goalId, input.ownerMemberId, input.status, input.limit, input.cursor)
  }

  async appendReport(actor: VerifiedAuthContext, input: AppendReportInput): Promise<import('../domain/ticket-view.ts').WriteOperationResult> {
    const binding = await this.#requireBinding(input.bindingId)
    await this.#requireAction(actor, binding.workspaceId, 'ticket.report', { goalId: binding.goalId, bindingId: binding.bindingId })
    await this.#requireGoal(binding.workspaceId, binding.goalId)
    await this.#requireReportMembers(actor, binding.workspaceId, binding.goalId, input.actorMemberId, input.executingMemberId)

    const operationRef: OperationRef = {
      workspaceId: binding.workspaceId,
      actorAccountId: actor.accountId,
      operationId: input.operationId,
    }
    const request: AppendReportRequest = {
      kind: 'appendReport',
      bindingId: input.bindingId,
      actorMemberId: input.actorMemberId,
      executingMemberId: input.executingMemberId,
      reportKind: input.reportKind,
      body: input.body,
    }
    const existing = await this.#store.recoverExpiredPending(operationRef, this.#now())
    if (existing) {
      this.#assertSameRequest(existing, request, operationRef)
      return { operation: this.#view(existing) }
    }

    const now = this.#now()
    const pending: WriteOperation = {
      operationRef,
      bindingId: binding.bindingId,
      kind: 'appendReport',
      request,
      state: 'pending',
      providerInstanceId: binding.providerInstanceId,
      externalProjectId: binding.externalProjectId,
      resolution: 'none',
      executionLeaseOwner: `tickets-${input.operationId}`,
      executionLeaseUntil: now + LEASE_MS,
    }
    const cas = await this.#store.createOperationIfAbsent(pending, { owner: pending.executionLeaseOwner ?? 'tickets', until: pending.executionLeaseUntil ?? now + LEASE_MS })
    if (!cas.created) {
      this.#assertSameRequest(cas.operation, request, operationRef)
      return { operation: this.#view(cas.operation) }
    }

    const provider = await this.#store.getProviderInstance(binding.providerInstanceId)
    if (!provider) {
      return { operation: this.#view(await this.#markOperation(operationRef, {
        ...cas.operation,
        state: 'failed',
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: `provider instance ${binding.providerInstanceId} is unavailable`,
        observedAt: now,
      })) }
    }
    const credential = await this.#credentials.getCredential(binding.providerInstanceId)
    const result = await this.#client.createComment({
      baseUrl: provider.baseUrl,
      token: credential.token,
      taskId: binding.externalTaskId,
      comment: input.body,
    })

    if (result.kind === 'transport-error') {
      return { operation: this.#view(await this.#markUnknown(cas.operation, 'WRITE_OUTCOME_UNKNOWN', result.cause)) }
    }
    if (result.status === 201 && result.value && typeof result.value.id === 'number') {
      const succeeded: WriteOperation = {
        ...cas.operation,
        state: 'succeeded',
        externalCommentId: result.value.id,
        observedAt: now,
        resolution: 'auto-verified',
        successSource: 'provider',
      }
      const claim = await this.#store.claimComment(operationRef, binding.bindingId, result.value.id, succeeded)
      if (claim.ok) return { operation: this.#view(succeeded) }
      throw new TicketError('BINDING_CONFLICT', 'comment is already claimed by another operation', { operationRef })
    }
    const mapping = mapWriteStatus(result.status)
    if (mapping.unknown) {
      return { operation: this.#view(await this.#markUnknown(cas.operation, mapping.code)) }
    }
    return {
      operation: this.#view(await this.#markOperation(operationRef, {
        ...cas.operation,
        state: 'failed',
        errorCode: mapping.code,
        errorMessage: mapping.code,
        observedAt: now,
      })),
    }
  }

  async close(actor: VerifiedAuthContext, input: MutateTicketStateInput): Promise<import('../domain/ticket-view.ts').WriteOperationResult> {
    return this.#mutateState(actor, input, true)
  }

  async reopen(actor: VerifiedAuthContext, input: MutateTicketStateInput): Promise<import('../domain/ticket-view.ts').WriteOperationResult> {
    return this.#mutateState(actor, input, false)
  }

  async confirmRemoteResult(actor: VerifiedAuthContext, input: ConfirmRemoteResultInput): Promise<import('../domain/ticket-view.ts').WriteOperationResult> {
    const workspaceId = input.operationRef.workspaceId
    // Permission precedes lookup so a denial never reveals whether the operation exists.
    await this.#requireAction(actor, workspaceId, 'ticket.operation.reconcile', {})
    const operation = await this.#store.recoverExpiredPending(input.operationRef, this.#now())
    if (!operation) throw new TicketError('BINDING_CONFLICT', 'operation not found', { operationRef: input.operationRef })
    if (input.attribution !== 'operation-produced' || !input.evidenceRef) {
      throw new TicketError('INVALID_REQUEST', 'manual reconciliation requires attribution=operation-produced and evidenceRef', { operationRef: input.operationRef })
    }
    // Only an unknown operation may be reconciled. A succeeded/failed/pending
    // operation must not be rebound to another provider object. A pending
    // operation with a live lease is refused so an active executor is never
    // preempted by manual reconciliation.
      if (operation.state !== 'unknown') {
        throw new TicketError('OPERATION_CONFLICT', 'only an unknown operation may be manually reconciled', { operationRef: input.operationRef })
      }

    if (operation.kind === 'create') {
      if (typeof input.candidateExternalTaskId !== 'number') throw new TicketError('INVALID_REQUEST', 'candidateExternalTaskId is required for create', { operationRef: input.operationRef })
      const fallback = operation.providerInstanceId && operation.externalProjectId !== undefined
        ? { providerInstanceId: operation.providerInstanceId, externalProjectId: operation.externalProjectId }
        : await this.#requireWorkspaceProvider(workspaceId)
      const providerInstanceId = fallback.providerInstanceId
      const provider = await this.#requireProviderInstance(providerInstanceId)
      const credential = await this.#credentials.getCredential(providerInstanceId)
      const read = await this.#client.getTask({ baseUrl: provider.baseUrl, token: credential.token, taskId: input.candidateExternalTaskId })
      if (read.kind === 'transport-error') throw new TicketError('PROVIDER_UNAVAILABLE', undefined, { operationRef: input.operationRef, retryDisposition: 'query', cause: read.cause })
      if (read.status !== 200 || !read.value) throw new TicketError('BINDING_CONFLICT', 'candidate task is not readable', { operationRef: input.operationRef })
      if (read.value.project_id !== fallback.externalProjectId) throw new TicketError('BINDING_CONFLICT', 'candidate task does not belong to the operation provider project', { operationRef: input.operationRef })
      if (await this.#store.getBindingByExternal(providerInstanceId, input.candidateExternalTaskId)) throw new TicketError('BINDING_CONFLICT', 'candidate task is already bound', { operationRef: input.operationRef })

      const request = operation.request as CreateRequest
      const binding: TicketBinding = {
        bindingId: await this.#store.allocateBindingId(),
        workspaceId,
        goalId: request.goalId,
        ownerMemberId: request.ownerMemberId,
        providerInstanceId,
        externalProjectId: fallback.externalProjectId,
        externalTaskId: input.candidateExternalTaskId,
        category: request.category,
        lastObservedTitle: read.value.title,
        lastObservedPriority: read.value.priority,
        lastObservedDone: read.value.done,
        lastObservedAt: input.providerObservedAt,
        stateIntentVersion: 0,
      }
      const succeeded: WriteOperation = {
        ...operation,
        bindingId: binding.bindingId,
        state: 'succeeded',
        externalTaskId: input.candidateExternalTaskId,
        observedAt: input.providerObservedAt,
        resolution: 'manually-verified',
        successSource: 'manual',
        verifiedBy: actor.accountId,
        verifiedAt: this.#now(),
        evidenceRef: input.evidenceRef,
      }
      const commit = await this.#store.commitWriteSuccess(succeeded, binding)
      if (commit.committed) return { operation: this.#view(succeeded) }
      throw new TicketError('BINDING_CONFLICT', commit.conflict === 'binding-conflict' ? 'candidate task is already bound' : 'operation was superseded or completed', { operationRef: input.operationRef })
    }

    if (operation.kind === 'appendReport') {
      if (typeof input.candidateExternalCommentId !== 'number') throw new TicketError('INVALID_REQUEST', 'candidateExternalCommentId is required for appendReport', { operationRef: input.operationRef })
      const binding = operation.bindingId ? await this.#store.getBinding(operation.bindingId) : undefined
      if (!binding) throw new TicketError('BINDING_CONFLICT', 'binding not found for appendReport', { operationRef: input.operationRef })
      const provider = await this.#requireProviderInstance(binding.providerInstanceId)
      const credential = await this.#credentials.getCredential(binding.providerInstanceId)
      const comments = await this.#client.listComments({ baseUrl: provider.baseUrl, token: credential.token, taskId: binding.externalTaskId })
      if (comments.kind === 'transport-error') throw new TicketError('PROVIDER_UNAVAILABLE', undefined, { operationRef: input.operationRef, retryDisposition: 'query', cause: comments.cause })
      const found = comments.value?.some((item) => item.id === input.candidateExternalCommentId)
      if (!found) throw new TicketError('BINDING_CONFLICT', 'candidate comment does not belong to the binding task', { operationRef: input.operationRef })
      const already = await this.#store.getOperationByExternalComment(binding.providerInstanceId, input.candidateExternalCommentId)
      if (already && (already.operationRef.workspaceId !== operation.operationRef.workspaceId || already.operationRef.actorAccountId !== operation.operationRef.actorAccountId || already.operationRef.operationId !== operation.operationRef.operationId)) {
        throw new TicketError('BINDING_CONFLICT', 'candidate comment is already claimed by another operation', { operationRef: input.operationRef })
      }
      const succeeded: WriteOperation = {
        ...operation,
        state: 'succeeded',
        externalCommentId: input.candidateExternalCommentId,
        observedAt: input.providerObservedAt,
        resolution: 'manually-verified',
        successSource: 'manual',
        verifiedBy: actor.accountId,
        verifiedAt: this.#now(),
        evidenceRef: input.evidenceRef,
      }
      const claim = await this.#store.claimComment(operation.operationRef, binding.bindingId, input.candidateExternalCommentId, succeeded)
      if (claim.ok) return { operation: this.#view(succeeded) }
      throw new TicketError('BINDING_CONFLICT', 'candidate comment is already claimed', { operationRef: input.operationRef })
    }

    throw new TicketError('INVALID_REQUEST', 'state operations do not use manual reconciliation', { operationRef: input.operationRef })
  }

  async listPendingWrites(actor: VerifiedAuthContext, workspaceId: string): Promise<PendingWriteObservation[]> {
    // Current read scope is checked first, with no store read before it.
    const readable = await this.#readers.hasWorkspaceAction({
      actor,
      workspaceId,
      action: 'ticket.read',
    })
    if (!readable) throw new TicketError('TICKET_SCOPE_FORBIDDEN')
    const reconcile = await this.#readers.hasWorkspaceAction({
      actor,
      workspaceId,
      action: 'ticket.operation.reconcile',
    })
    const operations = await this.#store.listPendingWrites({
      workspaceId,
      actorAccountId: reconcile ? undefined : actor.accountId,
      reconcile,
      states: ['unknown', 'pending', 'superseded'],
    })
    return operations.map((operation) => ({ operation: this.#view(operation), canReconcile: reconcile }))
  }

  async listForGoalTopFive(actor: VerifiedAuthContext, workspaceId: string, goalId: string): Promise<GoalTicketTopFiveObservation> {
    await this.#requireAction(actor, workspaceId, 'ticket.read', { goalId })
    await this.#requireGoal(workspaceId, goalId)
    // Collect one extra row: the fixed five plus enough to know whether a
    // further page exists, so the expansion cursor is not always empty.
    const collected = await this.#collect(workspaceId, goalId, undefined, 'open', 6, undefined)
    const page = collected.items
    return {
      goalId,
      items: page.slice(0, 5),
      freshness: collected.freshness === 'best-effort' ? 'stale' : collected.freshness,
      observedAt: collected.observationEndedAt,
      nextCursor: page.length > 5 ? encodeCursor(page[4]) : undefined,
      errorRef: collected.errorRef,
    }
  }

  async #mutateState(actor: VerifiedAuthContext, input: MutateTicketStateInput, targetDone: boolean): Promise<import('../domain/ticket-view.ts').WriteOperationResult> {
    const binding = await this.#requireBinding(input.bindingId)
    await this.#requireAction(actor, binding.workspaceId, 'ticket.state.write', { goalId: binding.goalId, bindingId: binding.bindingId })
    await this.#requireGoal(binding.workspaceId, binding.goalId)

    const kind: WriteOperationKind = targetDone ? 'close' : 'reopen'
    const operationRef: OperationRef = { workspaceId: binding.workspaceId, actorAccountId: actor.accountId, operationId: input.operationId }
    const request: StateRequest = { kind, bindingId: input.bindingId }
    const existing = await this.#store.recoverExpiredPending(operationRef, this.#now())
    if (existing) {
      this.#assertSameRequest(existing, request, operationRef)
      return { operation: this.#view(existing) }
    }

    const now = this.#now()
    const pending: WriteOperation = {
      operationRef,
      bindingId: binding.bindingId,
      kind,
      request,
      state: 'pending',
      providerInstanceId: binding.providerInstanceId,
      externalProjectId: binding.externalProjectId,
      resolution: 'none',
      executionLeaseOwner: `tickets-${input.operationId}`,
      executionLeaseUntil: now + LEASE_MS,
    }
    // beginStateOperation allocates the new intent atomically and supersedes
    // only older close/reopen operations for this binding.
    const cas = await this.#store.beginStateOperation(pending, { owner: pending.executionLeaseOwner ?? 'tickets', until: pending.executionLeaseUntil ?? now + LEASE_MS })
    if (!cas.created) {
      this.#assertSameRequest(cas.operation, request, operationRef)
      return { operation: this.#view(cas.operation) }
    }

    const operation = cas.operation
    const intentVersion = operation.intentVersion ?? 0
    const provider = await this.#store.getProviderInstance(binding.providerInstanceId)
    if (!provider) {
      return { operation: this.#view(await this.#markOperation(operationRef, {
        ...operation,
        state: 'failed',
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: `provider instance ${binding.providerInstanceId} is unavailable`,
        observedAt: now,
      })) }
    }
    const credential = await this.#credentials.getCredential(binding.providerInstanceId)
    const patched = await this.#client.updateTask({
      baseUrl: provider.baseUrl,
      token: credential.token,
      taskId: binding.externalTaskId,
      patch: { done: targetDone },
    })
    if (patched.kind === 'transport-error') {
      return { operation: this.#view(await this.#markUnknown(operation, 'WRITE_OUTCOME_UNKNOWN', patched.cause)) }
    }
    if (patched.status !== 200 || !patched.value) {
      const mapping = mapWriteStatus(patched.status)
      if (mapping.unknown) {
        return { operation: this.#view(await this.#markUnknown(operation, mapping.code)) }
      }
      return {
        operation: this.#view(await this.#markOperation(operationRef, {
          ...operation,
          state: 'failed',
          errorCode: mapping.code,
          errorMessage: mapping.code,
          observedAt: now,
        })),
      }
    }

    // close/reopen only succeeds after an explicit observation reaches the target state.
    const verified = await this.#client.getTask({ baseUrl: provider.baseUrl, token: credential.token, taskId: binding.externalTaskId })
    if (verified.kind === 'transport-error') {
      return { operation: this.#view(await this.#markUnknown(operation, 'WRITE_OUTCOME_UNKNOWN', verified.cause)) }
    }
    if (verified.status === 200 && verified.value && verified.value.done === targetDone) {
      const succeeded: WriteOperation = {
        ...operation,
        state: 'succeeded',
        observedAt: now,
        resolution: 'auto-verified',
        successSource: 'provider',
      }
      // The store refuses to resurrect an operation whose intent is no longer
      // current, so a late close cannot overwrite a newer reopen.
      const commit = await this.#store.commitWriteSuccess(succeeded, {
        ...binding,
        lastObservedDone: targetDone,
        lastObservedAt: now,
        stateIntentVersion: intentVersion,
      })
      if (commit.committed) return { operation: this.#view(succeeded) }
      return { operation: this.#view(commit.operation ?? (await this.#store.getOperation(operationRef)) ?? succeeded) }
    }
    return { operation: this.#view(await this.#markUnknown(operation)) }
  }

  async #collect(workspaceId: string, goalId: string | undefined, ownerMemberId: string | undefined, status: 'open' | 'closed' | 'all', limit: number, cursor?: string): Promise<TicketListObservation> {
    const bindings = await this.#store.listBindings({ workspaceId, goalId, ownerMemberId })
    const startedAt = this.#now()
    const items: TicketObservation[] = []
    let anyFresh = false
    let anyStale = false
    let anyUnavailable = false

    for (const binding of bindings) {
      // Each ticket resolves the provider instance fixed on its binding, not
      // the current workspace mapping.
      const provider = await this.#store.getProviderInstance(binding.providerInstanceId)
      if (!provider) {
        items.push(this.#observationFromBinding(binding, 'unavailable', startedAt, { code: 'PROVIDER_UNAVAILABLE', message: `provider instance ${binding.providerInstanceId} is unavailable` }))
        anyUnavailable = true
        continue
      }
      const credential = await this.#credentials.getCredential(binding.providerInstanceId)
      const result = await this.#client.getTask({ baseUrl: provider.baseUrl, token: credential.token, taskId: binding.externalTaskId })
      if (result.kind === 'transport-error') {
        const hasProjection = this.#hasProjection(binding)
        items.push(this.#observationFromBinding(binding, hasProjection ? 'stale' : 'unavailable', startedAt, { code: 'PROVIDER_UNAVAILABLE', message: 'provider unreachable', cause: causeSummary(result.cause) }))
        if (hasProjection) anyStale = true
        else anyUnavailable = true
        continue
      }
      if (result.status === 401 || result.status === 403) {
        throw new TicketError(result.status === 401 ? 'PROVIDER_UNAUTHORIZED' : 'PROVIDER_FORBIDDEN', undefined, { providerStatus: result.status })
      }
      if (result.status === 404) {
        items.push(this.#observationFromBinding(binding, 'unavailable', startedAt, { code: 'PROVIDER_NOT_FOUND' }))
        anyUnavailable = true
        continue
      }
      if (result.status === 200 && result.value) {
        await this.#store.putBinding({ ...binding, lastObservedTitle: result.value.title, lastObservedPriority: result.value.priority, lastObservedDone: result.value.done, lastObservedAt: startedAt })
        items.push(this.#observationFromTask(binding, result.value, 'fresh', startedAt))
        anyFresh = true
      } else {
        items.push(this.#observationFromBinding(binding, this.#hasProjection(binding) ? 'stale' : 'unavailable', startedAt, { code: 'PROVIDER_UNAVAILABLE' }))
        anyStale = true
      }
    }

    const filtered = items.filter((item) => {
      if (status === 'all') return true
      if (!item.ticket) return false
      return status === 'open' ? !item.ticket.done : item.ticket.done
    })

    filtered.sort(compareObservations)
    const paged = applyCursor(filtered, cursor)
    const page = paged.slice(0, Math.max(0, limit))
    const nextCursor = paged.length > page.length ? encodeCursor(page[page.length - 1]) : undefined

    const freshness = items.length === 0 ? 'unavailable' : (anyFresh && (anyStale || anyUnavailable)) ? 'best-effort' : anyFresh ? 'fresh' : anyStale ? 'stale' : 'unavailable'
    return {
      items: page,
      totalKnown: items.length,
      observationStartedAt: startedAt,
      observationEndedAt: this.#now(),
      freshness,
      nextCursor,
    }
  }

  async #requireAction(actor: VerifiedAuthContext, workspaceId: string, action: TicketAction, options?: { goalId?: string; bindingId?: string }): Promise<void> {
    const allowed = await this.#readers.hasWorkspaceAction({
      actor,
      workspaceId,
      goalId: options?.goalId,
      bindingId: options?.bindingId,
      action,
    })
    if (!allowed) throw new TicketError('TICKET_SCOPE_FORBIDDEN')
  }

  async #requireGoal(workspaceId: string, goalId: string): Promise<void> {
    const belongs = await this.#readers.goalBelongsToWorkspace(workspaceId, goalId)
    if (!belongs) throw new TicketError('TICKET_SCOPE_FORBIDDEN')
  }

  async #requireAssignableMember(actor: VerifiedAuthContext, workspaceId: string, goalId: string, memberId: string): Promise<void> {
    if (!(await this.#readers.memberExists(memberId))) throw new TicketError('TICKET_REPORT_DELEGATION_FORBIDDEN')
    if (await this.#readers.actorOwnsMember(actor, memberId)) return
    const delegated = await this.#readers.hasReportDelegation({ actor, workspaceId, goalId, actorMemberId: memberId })
    if (!delegated) throw new TicketError('TICKET_REPORT_DELEGATION_FORBIDDEN')
  }

  async #requireReportMembers(actor: VerifiedAuthContext, workspaceId: string, goalId: string, actorMemberId: string, executingMemberId?: string): Promise<void> {
    if (!(await this.#readers.memberExists(actorMemberId))) throw new TicketError('TICKET_REPORT_DELEGATION_FORBIDDEN')
    if (!(await this.#readers.actorOwnsMember(actor, actorMemberId))) {
      const delegated = await this.#readers.hasReportDelegation({ actor, workspaceId, goalId, actorMemberId, executingMemberId })
      if (!delegated) throw new TicketError('TICKET_REPORT_DELEGATION_FORBIDDEN')
    }
    if (executingMemberId !== undefined && executingMemberId !== null) {
      if (!(await this.#readers.memberExists(executingMemberId))) throw new TicketError('TICKET_REPORT_DELEGATION_FORBIDDEN')
      if (!(await this.#readers.actorOwnsMember(actor, executingMemberId))) {
        const delegated = await this.#readers.hasReportDelegation({ actor, workspaceId, goalId, actorMemberId, executingMemberId })
        if (!delegated) throw new TicketError('TICKET_REPORT_DELEGATION_FORBIDDEN')
      }
    }
  }

  async #requireBinding(bindingId: string): Promise<TicketBinding> {
    const binding = await this.#store.getBinding(bindingId)
    if (!binding) throw new TicketError('BINDING_CONFLICT', 'binding not found')
    return binding
  }

  async #requireWorkspaceProvider(workspaceId: string): Promise<{ providerInstanceId: string; externalProjectId: number }> {
    const provider = await this.#store.getWorkspaceProvider(workspaceId)
    if (!provider) throw new TicketError('BINDING_CONFLICT', 'workspace has no active provider mapping')
    return provider
  }

  async #requireProviderInstance(providerInstanceId: string): Promise<ProviderInstance> {
    const provider = await this.#store.getProviderInstance(providerInstanceId)
    if (!provider) throw new TicketError('PROVIDER_UNAVAILABLE', `provider instance ${providerInstanceId} is unavailable`)
    return provider
  }

  async #markOperation(ref: OperationRef, next: WriteOperation): Promise<WriteOperation> {
    const result = await this.#store.transitionOperation(ref, { states: ['pending', 'unknown'] }, next)
    if (result.ok) return next
    return result.current ?? (await this.#store.getOperation(ref)) ?? next
  }

  async #markUnknown(operation: WriteOperation, code: TicketErrorCode = 'WRITE_OUTCOME_UNKNOWN', cause?: unknown): Promise<WriteOperation> {
    return this.#markOperation(operation.operationRef, {
      ...operation,
      state: 'unknown',
      errorCode: code,
      errorMessage: code,
      errorCause: causeSummary(cause),
      observedAt: this.#now(),
    })
  }

  #assertSameRequest(operation: WriteOperation, request: unknown, ref: OperationRef): void {
    if (canonicalRequest(operation.request) !== canonicalRequest(request)) {
      throw new TicketError('OPERATION_CONFLICT', undefined, { operationRef: ref })
    }
  }

  #hasProjection(binding: TicketBinding): boolean {
    return binding.lastObservedTitle !== undefined || binding.lastObservedPriority !== undefined || binding.lastObservedDone !== undefined
  }

  #view(operation: WriteOperation): OperationView {
    return {
      operationRef: operation.operationRef,
      bindingId: operation.bindingId,
      kind: operation.kind,
      state: operation.state,
      externalTaskId: operation.externalTaskId,
      externalCommentId: operation.externalCommentId,
      intentVersion: operation.intentVersion,
      observedAt: operation.observedAt,
      resolution: operation.resolution,
      successSource: operation.successSource,
      freshness: operationFreshness(operation),
      errorRef: operation.errorCode ? { code: operation.errorCode, message: operation.errorMessage, cause: operation.errorCause } : undefined,
      retryDisposition: retryFor(operation),
      reconciliationAllowed: operation.state === 'unknown',
    }
  }

  #createResult(operation: WriteOperation, binding?: TicketBinding, ticket?: TicketObservation): import('../domain/ticket-view.ts').CreateTicketResult {
    return {
      operation: this.#view(operation),
      binding: binding ? this.#bindingView(binding) : undefined,
      ticket,
    }
  }

  #bindingView(binding: TicketBinding): TicketBindingView {
    return {
      bindingId: binding.bindingId,
      workspaceId: binding.workspaceId,
      goalId: binding.goalId,
      ownerMemberId: binding.ownerMemberId,
      category: binding.category,
      externalTaskId: binding.externalTaskId,
      providerInstanceId: binding.providerInstanceId,
    }
  }

  #observationFromTask(binding: TicketBinding, task: VikunjaTask, freshness: 'fresh' | 'stale' | 'unavailable', observedAt: number): TicketObservation {
    return {
      binding: this.#bindingView(binding),
      ticket: {
        externalTaskId: task.id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        done: task.done,
        doneAt: task.done_at,
        providerProjectId: task.project_id,
      },
      providerObservedAt: observedAt,
      freshness,
    }
  }

  #observationFromBinding(binding: TicketBinding, freshness: 'fresh' | 'stale' | 'unavailable', observedAt: number, errorRef?: { code: TicketErrorCode; message?: string; cause?: string }): TicketObservation {
    const ticket = this.#hasProjection(binding)
      ? {
          externalTaskId: binding.externalTaskId,
          title: binding.lastObservedTitle ?? '',
          priority: binding.lastObservedPriority ?? 0,
          done: binding.lastObservedDone ?? false,
        }
      : undefined
    return {
      binding: this.#bindingView(binding),
      ticket,
      providerObservedAt: binding.lastObservedAt ?? observedAt,
      freshness,
      errorRef,
    }
  }
}

interface SortKey {
  priority: number
  externalTaskId: number
  bindingId: string
}

function observationKey(observation: TicketObservation): SortKey {
  return {
    priority: observation.ticket?.priority ?? -Infinity,
    externalTaskId: observation.binding.externalTaskId,
    bindingId: observation.binding.bindingId,
  }
}

function compareObservations(left: TicketObservation, right: TicketObservation): number {
  const a = observationKey(left)
  const b = observationKey(right)
  if (a.priority !== b.priority) return b.priority - a.priority
  if (a.externalTaskId !== b.externalTaskId) return a.externalTaskId - b.externalTaskId
  return a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0
}

function encodeCursor(observation: TicketObservation | undefined): string | undefined {
  if (!observation) return undefined
  return Buffer.from(JSON.stringify(observationKey(observation))).toString('base64url')
}

function applyCursor(items: TicketObservation[], cursor: string | undefined): TicketObservation[] {
  if (!cursor) return items
  let parsed: SortKey
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as SortKey
  } catch {
    return items
  }
  return items.filter((item) => {
    const key = observationKey(item)
    if (key.priority !== parsed.priority) return key.priority < parsed.priority
    if (key.externalTaskId !== parsed.externalTaskId) return key.externalTaskId > parsed.externalTaskId
    return key.bindingId > parsed.bindingId
  })
}
