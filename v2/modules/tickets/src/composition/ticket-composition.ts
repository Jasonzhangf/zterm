import { TicketError } from '../public/errors.ts'
import type { RetryDisposition } from '../public/errors.ts'
import type { ProviderInstance } from '../domain/provider-instance.ts'
import type { TicketBinding, WorkspaceProviderBinding } from '../domain/ticket-binding.ts'
import type {
  CreateTicketInput,
  ListTicketsInput,
  TicketServiceOptions,
} from '../application/ticket-service.ts'
import { TicketService } from '../application/ticket-service.ts'
import { SqliteBindingStore } from '../adapters/sqlite-binding-store.ts'
import { VikunjaV2Adapter } from '../adapters/vikunja-v2/vikunja-adapter.ts'
import type { CredentialProviderPort } from '../ports/credential-provider.ts'
import type { VikunjaClientPort } from '../ports/vikunja-client.ts'
import type {
  ActionCheck,
  TicketAction,
  TicketPublicReaders,
  VerifiedAuthContext,
} from '../ports/ticket-public-readers.ts'
import type {
  GoalTicketTopFiveObservation,
  OperationView,
  PendingWriteObservation,
  TicketListObservation,
  TicketObservation,
} from '../domain/ticket-view.ts'
import type { AppendReportInput, GetTicketInput, MutateTicketStateInput } from '../application/ticket-service.ts'

type AccountAuthorization = {
  accountId: string
  scopes: readonly string[]
  workspaces?: readonly string[] | '*'
  members?: readonly string[]
}

type OrganizationMember = {
  memberId: string
  workspaceId?: string
}

export interface TicketCompositionProviderInstance {
  providerInstanceId: string
  baseUrl: string
  credentialRef: string
  status?: ProviderInstance['status']
}

export interface TicketCompositionWorkspaceProvider {
  workspaceId: string
  providerInstanceId: string
  externalProjectId: number
  authority: string
}

export interface TicketCompositionOptions {
  storeFile: string
  providerInstances: TicketCompositionProviderInstance[]
  workspaceProviders: TicketCompositionWorkspaceProvider[]
  credentialProvider: CredentialProviderPort
  vikunjaClient?: VikunjaClientPort
  accountReader: {
    readAuthorization(token: string): Promise<AccountAuthorization>
  }
  organization: {
    getMember(memberId: string): Promise<OrganizationMember | null>
  }
  goals: {
    goalBelongsToWorkspace(workspaceId: string, goalId: string): Promise<boolean>
  }
  actorResolver: {
    resolve(input: {
      token: string
      workspaceId: string
    }): Promise<VerifiedAuthContext>
  }
  actionScopes?: Partial<Record<TicketAction, string>>
  now?: () => number
}

const DEFAULT_ACTION_SCOPES: Record<TicketAction, string> = {
  'ticket.create': 'tickets:create',
  'ticket.read': 'tickets:read',
  'ticket.report': 'tickets:report',
  'ticket.state.write': 'tickets:state:write',
  'ticket.operation.reconcile': 'tickets:reconcile',
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeActor(actor: VerifiedAuthContext | undefined): VerifiedAuthContext {
  if (
    !actor
    || typeof actor !== 'object'
    || typeof actor.sessionId !== 'string'
    || actor.sessionId.trim().length === 0
    || typeof actor.accountId !== 'string'
    || actor.accountId.trim().length === 0
    || typeof actor.memberId !== 'string'
    || actor.memberId.trim().length === 0
    || actor.credentialState !== 'active'
  ) {
    throw new TicketError('TICKET_SCOPE_FORBIDDEN', 'verified ticket actor mapping is unavailable')
  }
  return actor
}

function workspaceAllowed(context: AccountAuthorization, workspaceId: string): boolean {
  if (context.workspaces === '*') return true
  return Array.isArray(context.workspaces) && context.workspaces.includes(workspaceId)
}

function actionAllowed(
  context: AccountAuthorization,
  action: TicketAction,
  scopes: Record<TicketAction, string>,
): boolean {
  const required = scopes[action]
  return Array.isArray(context.scopes) && context.scopes.includes(required)
}

function ticketView(observation: TicketObservation): Record<string, unknown> {
  const ticket = observation.ticket
  return {
    ticketId: observation.binding.bindingId,
    workspaceId: observation.binding.workspaceId,
    goalId: observation.binding.goalId,
    ownerMemberId: observation.binding.ownerMemberId,
    assigneeId: observation.binding.ownerMemberId,
    title: ticket?.title ?? observation.binding.bindingId,
    description: ticket?.description ?? '',
    priority: ticket?.priority ?? null,
    status: ticket?.done ? 'closed' : 'open',
    freshness: observation.freshness,
    errorRef: observation.errorRef,
    rawObservation: observation,
  }
}

function operationsView(operations: PendingWriteObservation[]): OperationView[] {
  return operations.map((entry) => entry.operation)
}

export function createTicketComposition(options: TicketCompositionOptions) {
  const store = new SqliteBindingStore({ path: requireText(options?.storeFile, 'storeFile') })
  const now = options?.now ?? Date.now
  const actionScopes = { ...DEFAULT_ACTION_SCOPES, ...(options.actionScopes ?? {}) }
  const providerInstances = Array.isArray(options.providerInstances) ? options.providerInstances : []
  const workspaceProviders = Array.isArray(options.workspaceProviders) ? options.workspaceProviders : []
  if (!options.credentialProvider || typeof options.credentialProvider.getCredential !== 'function') {
    throw new TypeError('ticket composition requires credentialProvider.getCredential')
  }
  if (!options.accountReader || typeof options.accountReader.readAuthorization !== 'function') {
    throw new TypeError('ticket composition requires accountReader.readAuthorization')
  }
  if (!options.organization || typeof options.organization.getMember !== 'function') {
    throw new TypeError('ticket composition requires organization.getMember')
  }
  if (!options.goals || typeof options.goals.goalBelongsToWorkspace !== 'function') {
    throw new TypeError('ticket composition requires goals.goalBelongsToWorkspace')
  }
  if (!options.actorResolver || typeof options.actorResolver.resolve !== 'function') {
    throw new TypeError('ticket composition requires actorResolver.resolve')
  }

  const ready = (async () => {
    for (const provider of providerInstances) {
      const providerInstance: ProviderInstance = {
        providerInstanceId: requireText(provider.providerInstanceId, 'providerInstances.providerInstanceId'),
        providerKind: 'vikunja-v2',
        baseUrl: requireText(provider.baseUrl, 'providerInstances.baseUrl'),
        credentialRef: requireText(provider.credentialRef, 'providerInstances.credentialRef'),
        status: provider.status ?? 'active',
        createdAt: now(),
      }
      await store.putProviderInstance(providerInstance)
    }
    for (const mapping of workspaceProviders) {
      const workspaceProvider: WorkspaceProviderBinding = {
        workspaceId: requireText(mapping.workspaceId, 'workspaceProviders.workspaceId'),
        providerInstanceId: requireText(mapping.providerInstanceId, 'workspaceProviders.providerInstanceId'),
        externalProjectId: mapping.externalProjectId,
        authority: requireText(mapping.authority, 'workspaceProviders.authority'),
        createdAt: now(),
        updatedAt: now(),
      }
      if (!Number.isSafeInteger(workspaceProvider.externalProjectId) || workspaceProvider.externalProjectId <= 0) {
        throw new TypeError('workspaceProviders.externalProjectId must be a positive integer')
      }
      await store.putWorkspaceProvider(workspaceProvider)
    }
  })()

  async function resolveActor(input: {
    token: string
    account: AccountAuthorization
    workspaceId: string
  }): Promise<VerifiedAuthContext> {
    if (typeof input?.token !== 'string' || input.token.length === 0) {
      throw new TicketError('TICKET_SCOPE_FORBIDDEN', 'verified session token is unavailable')
    }
    const account = input?.account
    if (!account || typeof account.accountId !== 'string' || account.accountId.trim() === '') {
      throw new TicketError('TICKET_SCOPE_FORBIDDEN', 'verified account context is unavailable')
    }
    const actor = normalizeActor(await options.actorResolver.resolve({
      token: input.token,
      workspaceId: input.workspaceId,
    }))
    if (actor.accountId !== account.accountId) {
      throw new TicketError('TICKET_SCOPE_FORBIDDEN', 'actor resolver returned a different account')
    }
    // The session id is an internal capability passed to public readers. It is
    // never serialized in a ticket, operation, board, or HTTP response.
    return { ...actor, sessionId: input.token }
  }

  const readers: TicketPublicReaders = {
    async hasWorkspaceAction(check: ActionCheck) {
      const context = await options.accountReader.readAuthorization(check.actor.sessionId)
      if (!workspaceAllowed(context, check.workspaceId)) return false
      if (!actionAllowed(context, check.action, actionScopes)) return false
      if (context.accountId !== check.actor.accountId) return false
      const member = await options.organization.getMember(check.actor.memberId)
      return Boolean(member && member.workspaceId === check.workspaceId)
    },
    async goalBelongsToWorkspace(workspaceId, goalId) {
      return options.goals.goalBelongsToWorkspace(workspaceId, goalId)
    },
    async memberExists(memberId) {
      return Boolean(await options.organization.getMember(memberId))
    },
    async actorOwnsMember(actor, memberId) {
      return actor.memberId === memberId
    },
    async hasReportDelegation() {
      return false
    },
  }

  const service = new TicketService({
    store,
    credentials: options.credentialProvider,
    client: options.vikunjaClient ?? new VikunjaV2Adapter(),
    readers,
    now,
  } satisfies TicketServiceOptions)

  async function authorizedTransitions(actor: VerifiedAuthContext, observation: TicketObservation) {
    if (observation.freshness !== 'fresh' || !observation.ticket) return []
    const allowed = await readers.hasWorkspaceAction({
      actor,
      workspaceId: observation.binding.workspaceId,
      goalId: observation.binding.goalId,
      bindingId: observation.binding.bindingId,
      action: 'ticket.state.write',
    })
    if (!allowed) return []
    return observation.ticket.done
      ? [{ to: 'reopen', label: 'Reopen' }]
      : [{ to: 'close', label: 'Close' }]
  }

  async function withTransitions(actor: VerifiedAuthContext, observation: TicketObservation) {
    return {
      ...observation,
      allowedTransitions: await authorizedTransitions(actor, observation),
    }
  }

  async function requireScopedBinding(
    actor: VerifiedAuthContext,
    workspaceId: string,
    bindingId: string,
    action: TicketAction,
  ): Promise<TicketBinding> {
    const allowed = await readers.hasWorkspaceAction({ actor, workspaceId, bindingId, action })
    if (!allowed) throw new TicketError('TICKET_SCOPE_FORBIDDEN')
    const binding = await store.getBinding(bindingId)
    if (!binding || binding.workspaceId !== workspaceId) {
      throw new TicketError('TICKET_SCOPE_FORBIDDEN')
    }
    return binding
  }

  const facade = {
    store,
    service,
    readers,
    resolveActor,
    async ready() {
      await ready
    },
    async create(actor: VerifiedAuthContext, input: CreateTicketInput) {
      await ready
      return service.create(actor, input)
    },
    async get(actor: VerifiedAuthContext, input: GetTicketInput) {
      await ready
      return service.get(actor, input)
    },
    async getInWorkspace(actor: VerifiedAuthContext, workspaceId: string, bindingId: string) {
      await ready
      await requireScopedBinding(actor, workspaceId, bindingId, 'ticket.read')
      return service.get(actor, { bindingId })
    },
    async list(actor: VerifiedAuthContext, input: ListTicketsInput) {
      await ready
      return service.list(actor, input)
    },
    async appendReport(actor: VerifiedAuthContext, input: AppendReportInput) {
      await ready
      return service.appendReport(actor, input)
    },
    async appendReportInWorkspace(
      actor: VerifiedAuthContext,
      workspaceId: string,
      input: AppendReportInput,
    ) {
      await ready
      await requireScopedBinding(actor, workspaceId, input.bindingId, 'ticket.report')
      return service.appendReport(actor, input)
    },
    async close(actor: VerifiedAuthContext, input: MutateTicketStateInput) {
      await ready
      return service.close(actor, input)
    },
    async closeInWorkspace(
      actor: VerifiedAuthContext,
      workspaceId: string,
      input: MutateTicketStateInput,
    ) {
      await ready
      await requireScopedBinding(actor, workspaceId, input.bindingId, 'ticket.state.write')
      return service.close(actor, input)
    },
    async reopen(actor: VerifiedAuthContext, input: MutateTicketStateInput) {
      await ready
      return service.reopen(actor, input)
    },
    async reopenInWorkspace(
      actor: VerifiedAuthContext,
      workspaceId: string,
      input: MutateTicketStateInput,
    ) {
      await ready
      await requireScopedBinding(actor, workspaceId, input.bindingId, 'ticket.state.write')
      return service.reopen(actor, input)
    },
    async listPendingWrites(actor: VerifiedAuthContext, workspaceId: string) {
      await ready
      return service.listPendingWrites(actor, workspaceId)
    },
    async listForGoalTopFive(actor: VerifiedAuthContext, workspaceId: string, goalId: string): Promise<GoalTicketTopFiveObservation> {
      await ready
      return service.listForGoalTopFive(actor, workspaceId, goalId)
    },
    async hasGoalReference(workspaceId: string, goalId: string) {
      await ready
      return (await store.listBindings({ workspaceId, goalId })).length > 0
    },
    async authorizedTransitions(actor: VerifiedAuthContext, observation: TicketObservation) {
      return authorizedTransitions(actor, observation)
    },
    async withTransitions(actor: VerifiedAuthContext, observation: TicketObservation) {
      return withTransitions(actor, observation)
    },
    async closeStore() {
      store.close()
    },
    ticketView,
    operationsView,
  }

  return Object.freeze(facade)
}

export type TicketComposition = ReturnType<typeof createTicketComposition>

// Keep the public retry union in the generated declaration surface used by
// daemon composition without re-exporting implementation details elsewhere.
export type { RetryDisposition }
