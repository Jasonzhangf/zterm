import assert from 'node:assert/strict'
import test from 'node:test'
import type { TicketObservation } from '../../../tickets/src/public/contracts.ts'
import { ManagerBoardReader, OrganizationPublicAdapter } from '../../src/public/contracts.ts'
import {
  expectBoardError,
  makeHarness,
  memberStatus,
  queryInput,
  ticketObservation,
  topFive,
  NOW,
} from '../support/harness.ts'

function service(harness: ReturnType<typeof makeHarness>) {
  return new ManagerBoardReader({ ...harness, now: () => NOW })
}

test('organization adapter rejects a service without the explicit listDirectReports query', () => {
  const legacyHierarchyService = {
    async queryTree() {
      return { root: { groups: [] } }
    },
  }

  assert.throws(
    () => new OrganizationPublicAdapter(legacyHierarchyService),
    expectBoardError('BOARD_INVALID_REQUEST'),
  )
})

test('organization adapter consumes listDirectReports and maps missing manager to null scope', async () => {
  const calls: Array<{ token: string; workspaceId: string; managerMemberId: string }> = []
  const adapter = new OrganizationPublicAdapter({
    async listDirectReports(input: { token: string; workspaceId: string; managerMemberId: string }) {
      calls.push(input)
      if (input.managerMemberId === 'missing-manager') {
        throw Object.assign(new Error('unknown member'), {
          name: 'TypedError',
          code: 'MEMBER_NOT_FOUND',
        })
      }
      return {
        workspaceId: input.workspaceId,
        managerMemberId: input.managerMemberId,
        directMemberIds: ['member-1'],
      }
    },
  })

  const scope = await adapter.readAuthorizedManagerScope({
    token: 'token-1',
    workspaceId: 'ws-1',
    managerId: 'manager-1',
  })
  const missing = await adapter.readAuthorizedManagerScope({
    token: 'token-1',
    workspaceId: 'ws-1',
    managerId: 'missing-manager',
  })

  assert.deepEqual(calls, [
    { token: 'token-1', workspaceId: 'ws-1', managerMemberId: 'manager-1' },
    { token: 'token-1', workspaceId: 'ws-1', managerMemberId: 'missing-manager' },
  ])
  assert.deepEqual(scope, {
    workspaceId: 'ws-1',
    managerId: 'manager-1',
    directMemberIds: ['member-1'],
  })
  assert.equal(missing, null)
})

test('success projects direct goals, ticket sections and member observations', async () => {
  const harness = makeHarness()
  const result = await service(harness).queryManagerBoard(queryInput())

  assert.equal(result.workspaceId, 'ws-1')
  assert.equal(result.managerId, 'manager-1')
  assert.deepEqual(result.goals.map((section) => section.goal.goalId), ['goal-1', 'goal-2'])
  assert.equal(result.goals[0]?.tickets.items.length, 3)
  assert.equal(result.goals[0]?.tickets.items[0]?.binding.externalTaskId, 20)
  assert.equal(result.goals[0]?.tickets.items[1]?.binding.externalTaskId, 10)
  assert.deepEqual(result.memberStatuses.map((observation) => observation.subjectRef.memberId), ['member-1', 'member-2'])
  assert.equal(result.memberStatuses[0]?.value, 'busy')
  assert.deepEqual(harness.tickets.calls.map((call) => call.goalId), ['goal-1', 'goal-2'])
  assert.deepEqual(harness.members.calls, ['member-1', 'member-2'])
})

test('authentication failure rejects the whole query before scope reads', async () => {
  const harness = makeHarness()
  harness.auth.error = Object.assign(new Error('missing token'), {
    name: 'AccountsError',
    code: 'AUTHENTICATION_REQUIRED',
  })

  await assert.rejects(
    service(harness).queryManagerBoard(queryInput({ token: 'invalid-token' })),
    expectBoardError('BOARD_UNAUTHORIZED'),
  )
  assert.equal(harness.organization.calls, 0)
  assert.equal(harness.tickets.calls.length, 0)
})

test('cross-workspace manager scope rejects typed without reading goals', async () => {
  const harness = makeHarness()
  harness.organization.scope = null

  await assert.rejects(
    service(harness).queryManagerBoard(queryInput({ workspaceId: 'ws-other' })),
    expectBoardError('BOARD_SCOPE_FORBIDDEN'),
  )
  assert.equal(harness.goals.calls.length, 0)
  assert.equal(harness.tickets.calls.length, 0)
})

test('same-priority order and top-five truncation are preserved from tickets port', async () => {
  const harness = makeHarness()
  const ordered: TicketObservation[] = [
    ticketObservation(10, 9),
    ticketObservation(11, 9),
    ticketObservation(12, 9),
    ticketObservation(13, 9),
    ticketObservation(14, 9),
  ]
  harness.goals.goals = [harness.goals.goals[0]!]
  harness.organization.scope = { workspaceId: 'ws-1', managerId: 'manager-1', directMemberIds: [] }
  harness.tickets.set('goal-1', topFive('goal-1', ordered, { nextCursor: 'sixth' }))

  const result = await service(harness).queryManagerBoard(queryInput())
  const items = result.goals[0]?.tickets.items ?? []

  assert.equal(items.length, 5)
  assert.deepEqual(items.map((item) => item.binding.externalTaskId), [10, 11, 12, 13, 14])
  assert.deepEqual(items.map((item) => item.ticket?.priority), [9, 9, 9, 9, 9])
  assert.equal(result.goals[0]?.tickets.nextCursor, 'sixth')
})

test('one ticket section failure stays local and preserves other goals', async () => {
  const harness = makeHarness()
  harness.tickets.set(
    'goal-1',
    Object.assign(new Error('provider down'), { name: 'TicketError', code: 'PROVIDER_UNAVAILABLE' }),
  )

  const result = await service(harness).queryManagerBoard(queryInput())

  assert.equal(result.goals.length, 2)
  assert.equal(result.goals[0]?.tickets.freshness, 'unavailable')
  assert.equal(result.goals[0]?.tickets.errorRef?.code, 'PROVIDER_UNAVAILABLE')
  assert.equal(result.goals[0]?.tickets.items.length, 0)
  assert.equal(result.goals[1]?.tickets.items.length, 1)
})

test('ticket provider failure preserves the goal and its unavailable section', async () => {
  const harness = makeHarness()
  harness.tickets.set(
    'goal-2',
    Object.assign(new Error('provider down'), { name: 'TicketError', code: 'PROVIDER_UNAVAILABLE' }),
  )

  const result = await service(harness).queryManagerBoard(queryInput())

  assert.deepEqual(result.goals.map((section) => section.goal.goalId), ['goal-1', 'goal-2'])
  assert.equal(result.goals[1]?.tickets.freshness, 'unavailable')
  assert.equal(result.goals[1]?.tickets.items.length, 0)
  assert.equal(result.goals[0]?.tickets.items.length, 3)
})

test('unavailable member status becomes unknown observation and does not erase other members', async () => {
  const harness = makeHarness()
  harness.members.set(
    'member-1',
    Object.assign(new Error('status provider down'), { name: 'TypedError', code: 'MEMBER_STATUS_UNAVAILABLE' }),
  )

  const result = await service(harness).queryManagerBoard(queryInput())

  assert.equal(result.memberStatuses.length, 2)
  assert.deepEqual(result.memberStatuses[0], {
    subjectRef: { kind: 'member', workspaceId: 'ws-1', memberId: 'member-1' },
    source: 'status-provider',
    observedAt: NOW,
    freshness: 'unavailable',
    value: 'unknown',
    errorRef: {
      code: 'MEMBER_STATUS_UNAVAILABLE',
      message: 'status provider down',
    },
  })
  assert.equal(result.memberStatuses[1]?.value, 'idle')
  assert.equal(result.memberStatuses[1]?.freshness, 'fresh')
  assert.equal(result.memberStatuses[0]?.source, 'status-provider')
  assert.equal(result.memberStatuses[0]?.freshness, 'unavailable')
})

test('ticket scope failure is required and rejects the whole query', async () => {
  const harness = makeHarness()
  harness.tickets.set(
    'goal-1',
    Object.assign(new Error('goal is outside caller scope'), { name: 'TicketError', code: 'TICKET_SCOPE_FORBIDDEN' }),
  )

  await assert.rejects(
    service(harness).queryManagerBoard(queryInput()),
    expectBoardError('BOARD_SCOPE_FORBIDDEN'),
  )
})

