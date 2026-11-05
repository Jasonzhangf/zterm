import type {
  AppendReportInput,
  BindingStorePort,
  CommitWriteResult,
  ConfirmRemoteResultInput,
  CreateOperationResult,
  CreateTicketInput,
  CreateTicketResult,
  CredentialProviderPort,
  GetTicketInput,
  GoalTicketTopFiveObservation,
  Lease,
  ListTicketsInput,
  MutateTicketStateInput,
  OperationFilter,
  OperationRef,
  PendingWriteObservation,
  PendingWriteScope,
  ProviderInstance,
  TicketBinding,
  TicketErrorCode,
  TicketListObservation,
  TicketObservation,
  TicketPublicReaders,
  TicketService as TicketServiceType,
  VerifiedAuthContext,
  VikunjaClientPort,
  VikunjaResult,
  VikunjaTask,
  VikunjaTaskPage,
  WriteOperation,
  WriteOperationResult,
  WorkspaceProviderBinding,
} from '../../src/public/contracts.ts'
import { InMemoryBindingStore, TicketService } from '../../src/public/contracts.ts'

export const NOW = Date.UTC(2026, 10, 3, 5, 0, 0)
export const VIKUNJA_BASE = 'http://vikunja.test/api/v2'
export const PROJECT_A = 3
export const PROJECT_B = 4

export function actor(accountId = 'acct-a', memberId = 'member-a'): VerifiedAuthContext {
  return { sessionId: `sess-${accountId}`, accountId, memberId, credentialState: 'active' }
}

export function task(partial: Partial<VikunjaTask> & { id: number }): VikunjaTask {
  return {
    id: partial.id,
    project_id: partial.project_id ?? PROJECT_A,
    title: partial.title ?? `task-${partial.id}`,
    description: partial.description ?? '',
    priority: partial.priority ?? 0,
    done: partial.done ?? false,
    done_at: partial.done_at ?? '0001-01-01T00:00:00Z',
  }
}

export function comment(partial: { id: number; comment?: string; created?: string; author?: { id: number; username?: string } }) {
  return {
    id: partial.id,
    comment: partial.comment ?? 'body',
    created: partial.created ?? '2026-11-03T05:00:00Z',
    author: partial.author ?? { id: 1, username: 'adapter-bot' },
  }
}

export function providerInstance(partial: Partial<ProviderInstance> & { providerInstanceId: string }): ProviderInstance {
  return {
    providerInstanceId: partial.providerInstanceId,
    providerKind: 'vikunja-v2',
    baseUrl: partial.baseUrl ?? VIKUNJA_BASE,
    credentialRef: partial.credentialRef ?? `cred-${partial.providerInstanceId}`,
    status: partial.status ?? 'active',
    createdAt: partial.createdAt ?? NOW,
  }
}

export function workspaceProvider(partial: Partial<WorkspaceProviderBinding> & { workspaceId: string }): WorkspaceProviderBinding {
  return {
    workspaceId: partial.workspaceId,
    providerInstanceId: partial.providerInstanceId ?? 'vk-1',
    externalProjectId: partial.externalProjectId ?? PROJECT_A,
    authority: partial.authority ?? 'authority-1',
    createdAt: partial.createdAt ?? NOW,
    updatedAt: partial.updatedAt ?? NOW,
  }
}

export function binding(partial: Partial<TicketBinding> & { bindingId: string }): TicketBinding {
  return {
    bindingId: partial.bindingId,
    workspaceId: partial.workspaceId ?? 'ws-1',
    goalId: partial.goalId ?? 'goal-1',
    ownerMemberId: partial.ownerMemberId ?? 'member-a',
    providerInstanceId: partial.providerInstanceId ?? 'vk-1',
    externalProjectId: partial.externalProjectId ?? PROJECT_A,
    externalTaskId: partial.externalTaskId ?? 27,
    category: partial.category ?? 'requirement',
    providerAssigneeId: partial.providerAssigneeId,
    lastObservedTitle: partial.lastObservedTitle,
    lastObservedPriority: partial.lastObservedPriority,
    lastObservedDone: partial.lastObservedDone,
    lastObservedAt: partial.lastObservedAt,
    stateIntentVersion: partial.stateIntentVersion ?? 0,
  }
}

export class FakeReaders implements TicketPublicReaders {
  allowAll = true
  deniedActions = new Set<string>()
  goalMismatch = false
  delegationGranted = false
  actorOwnsAllMembers = false
  memberMissing = false
  calls = 0

  async hasWorkspaceAction(check: { action: string }): Promise<boolean> {
    this.calls += 1
    if (!this.allowAll) return false
    return !this.deniedActions.has(check.action)
  }
  async goalBelongsToWorkspace(): Promise<boolean> {
    return !this.goalMismatch
  }
  async memberExists(): Promise<boolean> {
    return !this.memberMissing
  }
  async actorOwnsMember(current: VerifiedAuthContext, memberId: string): Promise<boolean> {
    return this.actorOwnsAllMembers || current.memberId === memberId
  }
  async hasReportDelegation(): Promise<boolean> {
    return this.delegationGranted
  }
}

export class FakeCredentials implements CredentialProviderPort {
  calls: string[] = []
  async getCredential(providerInstanceId: string) {
    this.calls.push(providerInstanceId)
    return { token: `token-${providerInstanceId}` }
  }
}

type Method = 'createTask' | 'getTask' | 'updateTask' | 'createComment' | 'listComments' | 'listTasks'
type Handler<T> = (input: any) => Promise<VikunjaResult<T>>

export class FakeVikunjaClient implements VikunjaClientPort {
  calls: Array<{ method: Method; input: any }> = []
  handlers = new Map<Method, Handler<any>>()

  set(method: Method, handler: Handler<any>): this {
    this.handlers.set(method, handler)
    return this
  }
  count(method: Method): number {
    return this.calls.filter((call) => call.method === method).length
  }
  private async invoke<T>(method: Method, input: any): Promise<VikunjaResult<T>> {
    this.calls.push({ method, input })
    const handler = this.handlers.get(method)
    if (!handler) {
      return { kind: 'transport-error', cause: new Error(`no fake handler for ${method}`) }
    }
    return handler(input)
  }
  createTask(input: any) {
    return this.invoke<VikunjaTask>('createTask', input)
  }
  getTask(input: any) {
    return this.invoke<VikunjaTask>('getTask', input)
  }
  updateTask(input: any) {
    return this.invoke<VikunjaTask>('updateTask', input)
  }
  createComment(input: any) {
    return this.invoke<VikunjaComment>('createComment', input)
  }
  listComments(input: any) {
    return this.invoke<VikunjaComment[]>('listComments', input)
  }
  listTasks(input: any) {
    return this.invoke<VikunjaTaskPage>('listTasks', input)
  }
}

const STORE_METHODS = [
  'getOperation',
  'putOperation',
  'createOperationIfAbsent',
  'beginStateOperation',
  'listOperations',
  'listPendingWrites',
  'getBinding',
  'getBindingByExternal',
  'getOperationByExternalComment',
  'listBindings',
  'putBinding',
  'allocateBindingId',
  'nextIntentVersion',
  'getWorkspaceProvider',
  'putWorkspaceProvider',
  'getProviderInstance',
  'putProviderInstance',
  'getMemberMapping',
  'commitWriteSuccess',
  'markOperation',
  'transitionOperation',
  'recoverExpiredPending',
  'claimComment',
] as const

export class SpyBindingStore implements BindingStorePort {
  readonly inner = new InMemoryBindingStore()
  counts: Record<string, number> = {}

  get total(): number {
    return Object.values(this.counts).reduce((sum, value) => sum + value, 0)
  }

  constructor() {
    for (const method of STORE_METHODS) {
      this.counts[method] = 0
      const self = this as any
      const original = (this.inner as any)[method].bind(this.inner)
      self[method] = async (...args: unknown[]) => {
        this.counts[method] += 1
        return original(...args)
      }
    }
  }

  getOperation(ref: OperationRef) {
    return this.inner.getOperation(ref)
  }
  putOperation(operation: WriteOperation) {
    return this.inner.putOperation(operation)
  }
  createOperationIfAbsent(operation: WriteOperation, lease: Lease): Promise<CreateOperationResult> {
    return this.inner.createOperationIfAbsent(operation, lease)
  }
  beginStateOperation(operation: WriteOperation, lease: Lease): Promise<CreateOperationResult> {
    return this.inner.beginStateOperation(operation, lease)
  }
  listOperations(filter: OperationFilter) {
    return this.inner.listOperations(filter)
  }
  listPendingWrites(filter: PendingWriteScope) {
    return this.inner.listPendingWrites(filter)
  }
  getBinding(bindingId: string) {
    return this.inner.getBinding(bindingId)
  }
  getBindingByExternal(providerInstanceId: string, externalTaskId: number) {
    return this.inner.getBindingByExternal(providerInstanceId, externalTaskId)
  }
  getOperationByExternalComment(providerInstanceId: string, externalCommentId: number) {
    return this.inner.getOperationByExternalComment(providerInstanceId, externalCommentId)
  }
  listBindings(filter: any) {
    return this.inner.listBindings(filter)
  }
  putBinding(bindingValue: TicketBinding) {
    return this.inner.putBinding(bindingValue)
  }
  allocateBindingId() {
    return this.inner.allocateBindingId()
  }
  nextIntentVersion(bindingId: string) {
    return this.inner.nextIntentVersion(bindingId)
  }
  getWorkspaceProvider(workspaceId: string) {
    return this.inner.getWorkspaceProvider(workspaceId)
  }
  putWorkspaceProvider(bindingValue: WorkspaceProviderBinding) {
    return this.inner.putWorkspaceProvider(bindingValue)
  }
  getProviderInstance(providerInstanceId: string) {
    return this.inner.getProviderInstance(providerInstanceId)
  }
  putProviderInstance(provider: ProviderInstance) {
    return this.inner.putProviderInstance(provider)
  }
  getMemberMapping(memberId: string, providerInstanceId: string) {
    return this.inner.getMemberMapping(memberId, providerInstanceId)
  }
  commitWriteSuccess(operation: WriteOperation, bindingValue?: TicketBinding): Promise<CommitWriteResult> {
    return this.inner.commitWriteSuccess(operation, bindingValue)
  }
  markOperation(operation: WriteOperation) {
    return this.inner.markOperation(operation)
  }
  transitionOperation(ref: OperationRef, expected: { states?: any; intentVersion?: number }, next: WriteOperation) {
    return this.inner.transitionOperation(ref, expected, next)
  }
  recoverExpiredPending(ref: OperationRef, now: number) {
    return this.inner.recoverExpiredPending(ref, now)
  }
  claimComment(ref: OperationRef, bindingId: string, externalCommentId: number, next: WriteOperation) {
    return this.inner.claimComment(ref, bindingId, externalCommentId, next)
  }
}

export interface Harness {
  service: TicketServiceType
  store: SpyBindingStore
  readers: FakeReaders
  credentials: FakeCredentials
  client: FakeVikunjaClient
}

export function makeService(options?: {
  store?: BindingStorePort
  client?: VikunjaClientPort
  readers?: TicketPublicReaders
  credentials?: CredentialProviderPort
}): TicketServiceType {
  return new TicketService({
    store: options?.store ?? new InMemoryBindingStore(),
    credentials: options?.credentials ?? new FakeCredentials(),
    client: options?.client ?? new FakeVikunjaClient(),
    readers: options?.readers ?? new FakeReaders(),
    now: () => NOW,
  })
}

export function makeHarness(options?: { withWorkspace?: boolean; providerInstanceId?: string; baseUrl?: string; projectId?: number }): Harness {
  const store = new SpyBindingStore()
  const readers = new FakeReaders()
  const credentials = new FakeCredentials()
  const client = new FakeVikunjaClient()
  const service = new TicketService({
    store,
    credentials,
    client,
    readers,
    now: () => NOW,
  })
  if (options?.withWorkspace !== false) {
    store.inner.putWorkspaceProvider(workspaceProvider({
      workspaceId: 'ws-1',
      providerInstanceId: options?.providerInstanceId ?? 'vk-1',
      externalProjectId: options?.projectId ?? PROJECT_A,
    }))
    store.inner.putProviderInstance(providerInstance({
      providerInstanceId: options?.providerInstanceId ?? 'vk-1',
      baseUrl: options?.baseUrl ?? VIKUNJA_BASE,
    }))
  }
  return { service, store, readers, credentials, client }
}

export function createInput(partial: Partial<CreateTicketInput> = {}): CreateTicketInput {
  return {
    operationId: partial.operationId ?? 'op-create-1',
    workspaceId: partial.workspaceId ?? 'ws-1',
    goalId: partial.goalId ?? 'goal-1',
    ownerMemberId: partial.ownerMemberId ?? 'member-a',
    category: partial.category ?? 'requirement',
    title: partial.title ?? 'Fix login',
    description: partial.description ?? 'body',
    priority: partial.priority ?? 10,
  }
}

export function getInput(bindingId = 'binding-1'): GetTicketInput {
  return { bindingId }
}

export function listInput(partial: Partial<ListTicketsInput> = {}): ListTicketsInput {
  return {
    workspaceId: partial.workspaceId ?? 'ws-1',
    goalId: partial.goalId,
    status: partial.status ?? 'open',
    ownerMemberId: partial.ownerMemberId,
    limit: partial.limit ?? 10,
    cursor: partial.cursor,
  }
}

export function appendInput(partial: Partial<AppendReportInput> = {}): AppendReportInput {
  return {
    operationId: partial.operationId ?? 'op-report-1',
    bindingId: partial.bindingId ?? 'binding-1',
    actorMemberId: partial.actorMemberId ?? 'member-a',
    executingMemberId: partial.executingMemberId,
    reportKind: partial.reportKind ?? 'status',
    body: partial.body ?? 'progress',
  }
}

export function stateInput(partial: Partial<MutateTicketStateInput> = {}): MutateTicketStateInput {
  return {
    operationId: partial.operationId ?? 'op-state-1',
    bindingId: partial.bindingId ?? 'binding-1',
  }
}

export function confirmInput(partial: Partial<ConfirmRemoteResultInput> = {}): ConfirmRemoteResultInput {
  return {
    operationRef: partial.operationRef ?? {
      workspaceId: 'ws-1',
      actorAccountId: 'acct-a',
      operationId: 'op-create-1',
    },
    candidateExternalTaskId: partial.candidateExternalTaskId,
    candidateExternalCommentId: partial.candidateExternalCommentId,
    providerObservedAt: partial.providerObservedAt ?? NOW,
    evidenceRef: partial.evidenceRef ?? 'evidence://manual/1',
    attribution: partial.attribution ?? 'operation-produced',
  }
}

export function expectTicketError(code: TicketErrorCode) {
  return (error: unknown): boolean => {
    const candidate = error as { code?: string; name?: string }
    if (!candidate || candidate.name !== 'TicketError' || candidate.code !== code) {
      throw new Error(`expected TicketError ${code}, got ${JSON.stringify(candidate)}`)
    }
    return true
  }
}

export type {
  CreateTicketResult,
  GoalTicketTopFiveObservation,
  PendingWriteObservation,
  TicketListObservation,
  TicketObservation,
  WriteOperationResult,
}
