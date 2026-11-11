import type { GoalTicketTopFiveObservation, TicketObservation, VerifiedAuthContext } from '../../../tickets/src/public/contracts.ts'
import type {
  BoardAuthReader,
  BoardOrganizationReader,
  BoardQueryInput,
  GoalReaderPort,
  MemberStatusReaderPort,
  MemberStatusObservation,
  ManagerScope,
  TicketReaderPort,
} from '../../src/public/contracts.ts'

export const NOW = Date.UTC(2026, 10, 7, 8, 0, 0)

export function actor(memberId = 'manager-1'): VerifiedAuthContext {
  return {
    sessionId: 'session-1',
    accountId: 'account-1',
    memberId,
    credentialState: 'active',
  }
}

export function queryInput(partial: Partial<BoardQueryInput> = {}): BoardQueryInput {
  return {
    token: partial.token ?? 'token-1',
    workspaceId: partial.workspaceId ?? 'ws-1',
    managerId: partial.managerId ?? 'manager-1',
  }
}

export function ticketObservation(
  externalTaskId: number,
  priority: number,
  goalId = 'goal-1',
  bindingId = `binding-${externalTaskId}`,
): TicketObservation {
  return {
    binding: {
      bindingId,
      workspaceId: 'ws-1',
      goalId,
      ownerMemberId: 'member-1',
      category: 'requirement',
      externalTaskId,
      providerInstanceId: 'provider-1',
    },
    ticket: {
      externalTaskId,
      title: `ticket-${externalTaskId}`,
      priority,
      done: false,
    },
    providerObservedAt: NOW,
    freshness: 'fresh',
  }
}

export function topFive(
  goalId: string,
  items: TicketObservation[],
  partial: Partial<GoalTicketTopFiveObservation> = {},
): GoalTicketTopFiveObservation {
  return {
    goalId,
    items,
    freshness: partial.freshness ?? 'fresh',
    observedAt: partial.observedAt ?? NOW,
    nextCursor: partial.nextCursor,
    errorRef: partial.errorRef,
  }
}

export function memberStatus(memberId: string, value: 'busy' | 'idle' = 'idle'): MemberStatusObservation {
  return {
    subjectRef: { kind: 'member', workspaceId: 'ws-1', memberId },
    source: 'status-reader',
    observedAt: NOW,
    freshness: 'fresh',
    value,
  }
}

export class FakeAuthReader implements BoardAuthReader {
  calls: Array<{ token: string; workspaceId: string }> = []
  error: unknown
  context: VerifiedAuthContext = actor()

  async verifySession(token: string, workspaceId: string): Promise<VerifiedAuthContext> {
    this.calls.push({ token, workspaceId })
    if (this.error) throw this.error
    return this.context
  }
}

export class FakeOrganizationReader implements BoardOrganizationReader {
  calls = 0
  scope: ManagerScope | null = {
    workspaceId: 'ws-1',
    managerId: 'manager-1',
    directMemberIds: ['member-1', 'member-2'],
  }

  async readAuthorizedManagerScope(): Promise<ManagerScope | null> {
    this.calls += 1
    return this.scope
  }
}

export class FakeGoalReader implements GoalReaderPort {
  calls: Array<{ token: string; workspaceId: string; managerId: string }> = []
  goals = [
    { goalId: 'goal-1', workspaceId: 'ws-1', managerId: 'manager-1', title: 'Goal 1', status: 'open' },
    { goalId: 'goal-2', workspaceId: 'ws-1', managerId: 'manager-1', title: 'Goal 2', status: 'open' },
  ]

  async listDirectForManager(input: { token: string; workspaceId: string; managerId: string }) {
    this.calls.push(input)
    return this.goals
  }
}

export class FakeTicketReader implements TicketReaderPort {
  calls: Array<{ workspaceId: string; goalId: string; actor: VerifiedAuthContext }> = []
  sections = new Map<string, GoalTicketTopFiveObservation | Error>()

  set(goalId: string, result: GoalTicketTopFiveObservation | Error): this {
    this.sections.set(goalId, result)
    return this
  }

  async listForGoalTopFive(_actor: VerifiedAuthContext, workspaceId: string, goalId: string) {
    this.calls.push({ workspaceId, goalId, actor: _actor })
    const result = this.sections.get(goalId)
    if (result instanceof Error) throw result
    if (!result) throw new Error(`no ticket result for ${goalId}`)
    return result
  }
}

export class FakeMemberStatusReader implements MemberStatusReaderPort {
  calls: string[] = []
  results = new Map<string, MemberStatusObservation | Error>()

  set(memberId: string, result: MemberStatusObservation | Error): this {
    this.results.set(memberId, result)
    return this
  }

  async observeMember(input: {
    actor: VerifiedAuthContext
    workspaceId: string
    memberId: string
  }) {
    const memberId = input.memberId
    this.calls.push(memberId)
    const result = this.results.get(memberId)
    if (result instanceof Error) throw result
    return result ?? memberStatus(memberId)
  }
}

export function makeHarness() {
  const auth = new FakeAuthReader()
  const organization = new FakeOrganizationReader()
  const goals = new FakeGoalReader()
  const tickets = new FakeTicketReader()
  const members = new FakeMemberStatusReader()
  tickets
    .set('goal-1', topFive('goal-1', [ticketObservation(20, 8), ticketObservation(10, 8), ticketObservation(30, 7)]))
    .set('goal-2', topFive('goal-2', [ticketObservation(40, 5, 'goal-2')]))
  members.set('member-1', memberStatus('member-1', 'busy')).set('member-2', memberStatus('member-2'))
  return { auth, accounts: auth, organization, goals, tickets, members }
}

export function expectBoardError(code: string) {
  return (error: unknown) => {
    const candidate = error as { name?: string; code?: string }
    return candidate?.name === 'BoardError' && candidate.code === code
  }
}

