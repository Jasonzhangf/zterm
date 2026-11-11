import assert from 'node:assert/strict'
import test from 'node:test'

import { createWebUIApp } from '../../src/app/app-shell.mjs'
import { createDemoPorts } from '../fixtures/demo-ports.mjs'

test('ticket shell retains an operation ID when a write result is unknown', async () => {
  const ports = createDemoPorts()
  const calls = []
  const daemonApi = {
    ...ports.daemonApi,
    async createTicket(payload) {
      calls.push({ operationId: payload.operationId, workspaceId: payload.workspaceId })
      throw Object.assign(new Error('ticket write outcome is unknown'), {
        code: 'TICKET_OPERATION_NOT_SUCCEEDED',
        category: 'tickets',
        operation: {
          operationRef: {
            workspaceId: payload.workspaceId,
            actorAccountId: 'account-a',
            operationId: payload.operationId,
          },
          kind: 'create',
          state: 'unknown',
          resolution: 'none',
          freshness: 'unknown',
          retryDisposition: 'manual-reconciliation',
          reconciliationAllowed: true,
        },
      })
    },
  }
  const app = createWebUIApp({
    daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready
  await app.navigate('tickets')
  const goalId = app.state.goalsLoadable.value?.[0]?.goalId

  const result = await app.dispatchAction('create-ticket', {
    workspaceId: 'ws-alpha',
    title: 'Unknown write ticket',
    description: 'The response was lost after provider dispatch.',
    goalId,
    ownerMemberId: 'm-1',
    priority: 3,
  })

  assert.equal(result.ok, false)
  assert.equal(calls.length, 1)
  assert.equal(result.error.operationId, calls[0].operationId)
  assert.equal(app.state.workTrackingOperations.length, 1)
  assert.equal(app.state.workTrackingOperations[0].operationId, calls[0].operationId)
  assert.equal(app.state.workTrackingOperations[0].state, 'unknown')
  assert.equal(app.state.workTrackingOperations[0].kind, 'create')
})
