import assert from 'node:assert/strict'
import test from 'node:test'

import { createDaemonApi } from '../../src/clients/daemon-api/index.mjs'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('daemon client exposes goal and ticket list methods through scoped routes', async () => {
  const calls = []
  const api = createDaemonApi({
    baseUrl: 'http://daemon.test',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options })
      if (String(url).endsWith('/api/workspaces/ws-1/goals')) {
        return jsonResponse({ goals: [{ goalId: 'goal-1', workspaceId: 'ws-1', name: 'Goal One', ownerMemberId: 'member-1', status: 'active' }] })
      }
      if (String(url).endsWith('/api/workspaces/ws-1/tickets?status=open')) {
        return jsonResponse({
          items: [{
            binding: { bindingId: 'binding-1', workspaceId: 'ws-1', goalId: 'goal-1', ownerMemberId: 'member-1', category: 'requirement', externalTaskId: 7, providerInstanceId: 'vk-1' },
            ticket: { externalTaskId: 7, title: 'Ticket One', priority: 2, done: false },
            providerObservedAt: 10,
            freshness: 'fresh',
          }],
          observationStartedAt: 10,
          observationEndedAt: 11,
          freshness: 'fresh',
        })
      }
      throw new Error(`unexpected request ${url}`)
    },
  })

  const goals = await api.listGoals({ workspaceId: 'ws-1' })
  assert.deepEqual(goals, [{ goalId: 'goal-1', workspaceId: 'ws-1', title: 'Goal One', ownerMemberId: 'member-1', status: 'active', rawGoal: { goalId: 'goal-1', workspaceId: 'ws-1', name: 'Goal One', ownerMemberId: 'member-1', status: 'active' } }])

  const tickets = await api.listTickets({ workspaceId: 'ws-1', status: 'open' })
  assert.equal(tickets[0].ticketId, 'binding-1')
  assert.equal(tickets[0].title, 'Ticket One')
  assert.equal(tickets[0].status, 'open')
  assert.equal(tickets.observation.freshness, 'fresh')
  assert.equal(calls.length, 2)
})

test('daemon client translates goal create and authoritative ticket transitions', async () => {
  const calls = []
  const api = createDaemonApi({
    baseUrl: 'http://daemon.test',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options })
      if (String(url).endsWith('/api/workspaces/ws-1/goals') && options.method === 'POST') {
        return jsonResponse({ goal: { goalId: 'goal-2', workspaceId: 'ws-1', name: 'Goal Two', ownerMemberId: 'member-1', status: 'active' } })
      }
      if (String(url).endsWith('/api/workspaces/ws-1/tickets/binding-1/close')) {
        return jsonResponse({ operation: { operationRef: { workspaceId: 'ws-1', actorAccountId: 'account-1', operationId: 'op-close' }, kind: 'close', state: 'succeeded', resolution: 'auto-verified', successSource: 'provider', freshness: 'fresh', retryDisposition: 'none', reconciliationAllowed: false } })
      }
      if (String(url).endsWith('/api/workspaces/ws-1/tickets/binding-1')) {
        return jsonResponse({
          binding: { bindingId: 'binding-1', workspaceId: 'ws-1', goalId: 'goal-2', ownerMemberId: 'member-1', category: 'requirement', externalTaskId: 7, providerInstanceId: 'vk-1' },
          ticket: { externalTaskId: 7, title: 'Ticket One', priority: 2, done: true },
          providerObservedAt: 12,
          freshness: 'fresh',
          allowedTransitions: [{ to: 'reopen', label: 'Reopen' }],
        })
      }
      throw new Error(`unexpected request ${url}`)
    },
  })

  const goal = await api.createGoal({ workspaceId: 'ws-1', title: 'Goal Two', ownerMemberId: 'member-1' })
  assert.equal(goal.title, 'Goal Two')
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'Goal Two', ownerMemberId: 'member-1' })

  const updated = await api.transitionTicket({ workspaceId: 'ws-1', ticketId: 'binding-1', operationId: 'op-close', transition: 'close' })
  assert.equal(updated.status, 'closed')
  assert.equal(updated.allowedTransitions[0].to, 'reopen')
})
