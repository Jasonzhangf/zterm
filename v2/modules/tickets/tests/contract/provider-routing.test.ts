import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actor,
  appendInput,
  binding,
  createInput,
  expectTicketError,
  getInput,
  makeHarness,
  providerInstance,
  stateInput,
  task,
  VIKUNJA_BASE,
  workspaceProvider,
} from '../support/harness.ts'

const BASE_B = 'http://vikunja-b.test/api/v2'

test('get/appendReport/state resolve the binding provider, not the current workspace mapping', async () => {
  const { service, store, client, credentials } = makeHarness()
  await store.inner.putProviderInstance(providerInstance({ providerInstanceId: 'vk-2', baseUrl: BASE_B, status: 'active' }))
  await store.inner.putBinding(binding({ bindingId: 'binding-1' }))
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27 }) }))
  client.set('createComment', async () => ({ kind: 'ok', status: 201, value: { id: 8, comment: 'body', created: 'x', author: { id: 1 } } }))
  client.set('updateTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done: true, done_at: '2026-11-03T05:00:01Z' }) }))

  // Move the workspace mapping to a different provider.
  await store.inner.putWorkspaceProvider(workspaceProvider({
    workspaceId: 'ws-1',
    providerInstanceId: 'vk-2',
    externalProjectId: 4,
  }))

  await service.get(actor(), getInput('binding-1'))
  const getCall = client.calls.find((call) => call.method === 'getTask')
  assert.equal(getCall?.input.baseUrl, VIKUNJA_BASE)
  assert.equal(credentials.calls.at(-1), 'vk-1')

  await service.appendReport(actor(), appendInput())
  const reportCall = client.calls.find((call) => call.method === 'createComment')
  assert.equal(reportCall?.input.baseUrl, VIKUNJA_BASE)
  assert.equal(reportCall?.input.taskId, 27)

  await service.close(actor(), stateInput())
  const stateCall = client.calls.find((call) => call.method === 'updateTask')
  assert.equal(stateCall?.input.baseUrl, VIKUNJA_BASE)
  assert.equal(stateCall?.input.taskId, 27)
})

test('two providers with the same task id stay isolated through their own bindings', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putProviderInstance(providerInstance({ providerInstanceId: 'vk-2', baseUrl: BASE_B, status: 'active' }))
  await store.inner.putWorkspaceProvider(workspaceProvider({
    workspaceId: 'ws-2',
    providerInstanceId: 'vk-2',
    externalProjectId: 40,
  }))
  await store.inner.putBinding(binding({ bindingId: 'binding-a', workspaceId: 'ws-1', providerInstanceId: 'vk-1', externalTaskId: 27 }))
  await store.inner.putBinding(binding({ bindingId: 'binding-b', workspaceId: 'ws-2', providerInstanceId: 'vk-2', externalTaskId: 27 }))
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27 }) }))

  await service.get(actor(), getInput('binding-a'))
  assert.equal(client.calls.at(-1)?.input.baseUrl, VIKUNJA_BASE)
  await service.get(actor(), getInput('binding-b'))
  assert.equal(client.calls.at(-1)?.input.baseUrl, BASE_B)
})

test('an unavailable fixed instance errors without falling back to a new instance', async () => {
  const { service, store, client, credentials } = makeHarness({ withWorkspace: false })
  await store.inner.putProviderInstance(providerInstance({ providerInstanceId: 'vk-2', baseUrl: BASE_B, status: 'active' }))
  await store.inner.putBinding(binding({ bindingId: 'binding-1' }))
  await store.inner.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-1', providerInstanceId: 'vk-2', externalProjectId: 4 }))
  const before = client.count('getTask')

  const observation = await service.get(actor(), getInput('binding-1'))
  assert.equal(observation.freshness, 'unavailable')
  assert.equal(observation.errorRef?.code, 'PROVIDER_UNAVAILABLE')
  assert.equal(client.count('getTask'), before)
  assert.equal(credentials.calls.length, 0)
})

test('a create pending operation keeps its fixed provider/project for manual reconciliation', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putProviderInstance(providerInstance({ providerInstanceId: 'vk-2', baseUrl: BASE_B, status: 'active' }))
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: null }))
  await service.create(actor(), createInput({ operationId: 'op-create-fixed' }))

  // Change mapping before reconciliation.
  await store.inner.putWorkspaceProvider(workspaceProvider({
    workspaceId: 'ws-1',
    providerInstanceId: 'vk-2',
    externalProjectId: 4,
  }))

  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 30, project_id: 3 }) }))
  const result = await service.confirmRemoteResult(
    actor(),
    {
      operationRef: { workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-create-fixed' },
      candidateExternalTaskId: 30,
      providerObservedAt: 0,
      evidenceRef: 'evidence://manual/1',
      attribution: 'operation-produced',
    },
  )
  assert.equal(result.operation.state, 'succeeded')
  assert.equal(client.calls.find((call) => call.method === 'getTask')?.input.baseUrl, VIKUNJA_BASE)
})
