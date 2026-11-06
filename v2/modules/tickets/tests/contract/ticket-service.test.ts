import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actor,
  appendInput,
  confirmInput,
  createInput,
  expectTicketError,
  getInput,
  listInput,
  makeHarness,
  stateInput,
  task,
} from '../support/harness.ts'

test('create succeeds, binds workspace/goal/member, and writes provider exactly once', async () => {
  const { service, store, client } = makeHarness()
  client.set('createTask', async (input) => {
    assert.equal(input.projectId, 3)
    assert.equal(input.title, 'Fix login')
    return { kind: 'ok', status: 201, value: task({ id: 27, title: 'Fix login', priority: 10 }) }
  })

  const result = await service.create(actor(), createInput())

  assert.equal(result.operation.state, 'succeeded')
  assert.equal(result.operation.externalTaskId, 27)
  assert.equal(result.operation.successSource, 'provider')
  assert.equal(result.binding?.externalTaskId, 27)
  assert.equal(result.binding?.goalId, 'goal-1')
  assert.equal(client.count('createTask'), 1)
  const binding = await store.inner.getBindingByExternal('vk-1', 27)
  assert.equal(binding?.ownerMemberId, 'member-a')
})

test('same OperationRef with same request replays without a second provider call', async () => {
  const { service, client } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: task({ id: 27 }) }))

  const first = await service.create(actor(), createInput())
  const second = await service.create(actor(), createInput())

  assert.equal(first.operation.operationId, second.operation.operationId)
  assert.equal(first.operation.externalTaskId, second.operation.externalTaskId)
  assert.equal(client.count('createTask'), 1)
})

test('same OperationRef with a different typed request is OPERATION_CONFLICT with no provider call', async () => {
  const { service, client } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: task({ id: 27 }) }))
  await service.create(actor(), createInput({ operationId: 'op-1', title: 'A' }))

  await assert.rejects(
    service.create(actor(), createInput({ operationId: 'op-1', title: 'B' })),
    expectTicketError('OPERATION_CONFLICT'),
  )
  assert.equal(client.count('createTask'), 1)
})

test('scope denial rejects before touching the store', async () => {
  const { service, store, readers } = makeHarness()
  readers.deniedActions.add('ticket.create')

  await assert.rejects(
    service.create(actor(), createInput()),
    expectTicketError('TICKET_SCOPE_FORBIDDEN'),
  )
  assert.equal(store.total, 0)
})

test('rejecting a non-self owner member without delegation is delegation-forbidden with no store calls', async () => {
  const { service, store } = makeHarness()
  await assert.rejects(
    service.create(actor('acct-a', 'member-a'), createInput({ ownerMemberId: 'member-b' })),
    expectTicketError('TICKET_REPORT_DELEGATION_FORBIDDEN'),
  )
  assert.equal(store.total, 0)
})

test('provider 201 without a stable task id stays unknown and is never re-POSTed', async () => {
  const { service, client, store } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: null }))

  const first = await service.create(actor(), createInput())
  assert.equal(first.operation.state, 'unknown')

  const replay = await service.create(actor(), createInput())
  assert.equal(replay.operation.state, 'unknown')
  assert.equal(client.count('createTask'), 1)
  assert.equal((await store.inner.listOperations({ workspaceId: 'ws-1' }))[0]?.state, 'unknown')
})

test('transport failure maps create to unknown without retry', async () => {
  const { service, client } = makeHarness()
  client.set('createTask', async () => ({ kind: 'transport-error', cause: new Error('timeout') }))

  const result = await service.create(actor(), createInput())
  assert.equal(result.operation.state, 'unknown')
  assert.equal(result.operation.retryDisposition, 'manual-reconciliation')
  assert.equal(client.count('createTask'), 1)
})

test('get returns a fresh observation and records lastObserved fields', async () => {
  const { service, store, client } = makeHarness()
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
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, priority: 42 }) }))

  const observation = await service.get(actor(), getInput('binding-1'))
  assert.equal(observation.freshness, 'fresh')
  assert.equal(observation.ticket.priority, 42)
  assert.equal((await store.inner.getBinding('binding-1'))?.lastObservedPriority, 42)
})

test('get maps provider 401 to PROVIDER_UNAUTHORIZED and never returns stale cache', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putBinding({
    bindingId: 'binding-1',
    workspaceId: 'ws-1',
    goalId: 'goal-1',
    ownerMemberId: 'member-a',
    providerInstanceId: 'vk-1',
    externalTaskId: 27,
    category: 'requirement',
    stateIntentVersion: 1,
    lastObservedPriority: 9,
    lastObservedAt: 0,
  })
  client.set('getTask', async () => ({ kind: 'ok', status: 401, value: null }))

  await assert.rejects(service.get(actor(), getInput('binding-1')), expectTicketError('PROVIDER_UNAUTHORIZED'))
})

test('get with no projection and transport failure is unavailable, not empty', async () => {
  const { service, store, client } = makeHarness()
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
  client.set('getTask', async () => ({ kind: 'transport-error', cause: new Error('down') }))

  const observation = await service.get(actor(), getInput('binding-1'))
  assert.equal(observation.freshness, 'unavailable')
})

test('list scope denial happens before any store read', async () => {
  const { service, store, readers } = makeHarness()
  readers.deniedActions.add('ticket.read')
  await assert.rejects(
    service.list(actor(), listInput()),
    expectTicketError('TICKET_SCOPE_FORBIDDEN'),
  )
  assert.equal(store.total, 0)
})

test('appendReport succeeds with a comment id and no auto retry', async () => {
  const { service, store, client } = makeHarness()
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
  client.set('createComment', async (input) => {
    assert.equal(input.taskId, 27)
    assert.equal(input.comment, 'progress')
    return { kind: 'ok', status: 201, value: { id: 8, comment: 'body', created: 'x', author: { id: 1 } } }
  })

  const result = await service.appendReport(actor(), appendInput())
  assert.equal(result.operation.state, 'succeeded')
  assert.equal(result.operation.externalCommentId, 8)
  assert.equal(client.count('createComment'), 1)
})

test('appendReport provider 403 is failed PROVIDER_FORBIDDEN', async () => {
  const { service, store, client } = makeHarness()
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
  client.set('createComment', async () => ({ kind: 'ok', status: 403, value: null }))

  const result = await service.appendReport(actor(), appendInput())
  assert.equal(result.operation.state, 'failed')
  assert.equal(result.operation.errorRef?.code, 'PROVIDER_FORBIDDEN')
})

test('appendReport rejects a self-reported member mismatch before any provider call', async () => {
  const { service, store, client } = makeHarness()
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
  await assert.rejects(
    service.appendReport(actor('acct-a', 'member-a'), appendInput({ actorMemberId: 'member-b' })),
    expectTicketError('TICKET_REPORT_DELEGATION_FORBIDDEN'),
  )
  assert.equal(client.count('createComment'), 0)
})

test('close succeeds only after provider observation reaches the target state', async () => {
  const { service, store, client } = makeHarness()
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
  client.set('updateTask', async (input) => {
    assert.equal(input.patch.done, true)
    return { kind: 'ok', status: 200, value: task({ id: 27, done: true, done_at: '2026-11-03T05:00:01Z' }) }
  })
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done: true, done_at: '2026-11-03T05:00:01Z' }) }))

  const result = await service.close(actor(), stateInput())
  assert.equal(result.operation.state, 'succeeded')
  assert.equal(client.count('updateTask'), 1)
})

test('confirmRemoteResult requires reconcile permission and refuses before leaking operation content', async () => {
  const { service, readers } = makeHarness()
  readers.deniedActions.add('ticket.operation.reconcile')
  await assert.rejects(
    service.confirmRemoteResult(actor(), confirmInput()),
    expectTicketError('TICKET_SCOPE_FORBIDDEN'),
  )
})

test('confirmRemoteResult refuses without explicit attribution evidence', async () => {
  const { service, client } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: null }))
  await service.create(actor(), createInput())

  await assert.rejects(
    service.confirmRemoteResult(actor(), confirmInput({ evidenceRef: '' })),
    expectTicketError('INVALID_REQUEST'),
  )
})

test('confirmRemoteResult records manual success and never claims a provider receipt', async () => {
  const { service, client } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: null }))
  await service.create(actor(), createInput({ operationId: 'op-create-1', title: 'Fix login' }))

  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 30, title: 'Fix login', priority: 10 }) }))

  const result = await service.confirmRemoteResult(
    actor(),
    confirmInput({ candidateExternalTaskId: 30, evidenceRef: 'evidence://manual/1' }),
  )
  assert.equal(result.operation.state, 'succeeded')
  assert.equal(result.operation.resolution, 'manually-verified')
  assert.equal(result.operation.successSource, 'manual')
})
