import assert from 'node:assert/strict'
import test from 'node:test'
import { actor, appendInput, createInput, getInput, makeHarness, task } from '../support/harness.ts'

async function seed(store: ReturnType<typeof makeHarness>['store']) {
  await store.inner.putBinding({
    bindingId: 'binding-1',
    workspaceId: 'ws-1',
    goalId: 'goal-1',
    ownerMemberId: 'member-a',
    providerInstanceId: 'vk-1',
    externalTaskId: 27,
    category: 'requirement',
    stateIntentVersion: 1,
  })
}

test('create maps explicit provider rejections to failed operations', async () => {
  const cases: Array<[number, string]> = [
    [400, 'PROVIDER_VALIDATION_FAILED'],
    [401, 'PROVIDER_UNAUTHORIZED'],
    [403, 'PROVIDER_FORBIDDEN'],
    [404, 'PROVIDER_NOT_FOUND'],
  ]
  for (const [status, code] of cases) {
    const { service, client } = makeHarness()
    client.set('createTask', async () => ({ kind: 'ok', status, value: null }))
    const result = await service.create(actor(), createInput({ operationId: `op-${status}` }))
    assert.equal(result.operation.state, 'failed', `status ${status}`)
    assert.equal(result.operation.errorRef?.code, code)
  }
})

test('create maps 5xx to unknown with manual reconciliation', async () => {
  const { service, client } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 502, value: null }))
  const result = await service.create(actor(), createInput())
  assert.equal(result.operation.state, 'unknown')
  assert.equal(result.operation.errorRef?.code, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(result.operation.retryDisposition, 'manual-reconciliation')
})

test('get maps 404 to PROVIDER_NOT_FOUND', async () => {
  const { service, store, client } = makeHarness()
  await seed(store)
  client.set('getTask', async () => ({ kind: 'ok', status: 404, value: null }))
  await assert.rejects(service.get(actor(), getInput('binding-1')), (error: any) => {
    assert.equal(error.name, 'TicketError')
    assert.equal(error.code, 'PROVIDER_NOT_FOUND')
    return true
  })
})

test('appendReport maps 400 to failed and 500 to unknown', async () => {
  const failed = makeHarness()
  await seed(failed.store)
  failed.client.set('createComment', async () => ({ kind: 'ok', status: 400, value: null }))
  const refused = await failed.service.appendReport(actor(), appendInput({ operationId: 'op-a' }))
  assert.equal(refused.operation.state, 'failed')
  assert.equal(refused.operation.errorRef?.code, 'PROVIDER_VALIDATION_FAILED')

  const unknown = makeHarness()
  await seed(unknown.store)
  unknown.client.set('createComment', async () => ({ kind: 'ok', status: 503, value: null }))
  const maybe = await unknown.service.appendReport(actor(), appendInput({ operationId: 'op-b' }))
  assert.equal(maybe.operation.state, 'unknown')
  assert.equal(maybe.operation.errorRef?.code, 'WRITE_OUTCOME_UNKNOWN')
})

test('successful create parses the provider id and project from the task body', async () => {
  const { service, client } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: task({ id: 77, priority: 33 }) }))
  const result = await service.create(actor(), createInput())
  assert.equal(result.operation.externalTaskId, 77)
  assert.equal(result.ticket?.ticket.priority, 33)
  assert.equal(result.ticket?.ticket.providerProjectId, 3)
})
