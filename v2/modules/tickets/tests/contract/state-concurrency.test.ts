import assert from 'node:assert/strict'
import test from 'node:test'
import { actor, binding, makeHarness, stateInput, task } from '../support/harness.ts'

test('a late in-flight close cannot overwrite a newer reopen intent', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putBinding(binding({ bindingId: 'binding-1', stateIntentVersion: 1 }))

  let releaseClose!: () => void
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve
  })
  let closeStarted!: () => void
  const closeStartedGate = new Promise<void>((resolve) => {
    closeStarted = resolve
  })
  let providerDone = false

  client.set('updateTask', async (input) => {
    if (input.patch.done === true) {
      closeStarted()
      await closeGate
      providerDone = true
      return { kind: 'ok', status: 200, value: task({ id: 27, done: true, done_at: '2026-11-03T05:00:02Z' }) }
    }
    providerDone = false
    return { kind: 'ok', status: 200, value: task({ id: 27, done: false }) }
  })
  client.set('getTask', async () => ({
    kind: 'ok',
    status: 200,
    value: task({ id: 27, done: providerDone, done_at: providerDone ? '2026-11-03T05:00:02Z' : '0001-01-01T00:00:00Z' }),
  }))

  const closePromise = service.close(actor(), stateInput({ operationId: 'op-close' }))
  await closeStartedGate

  const reopened = await service.reopen(actor(), stateInput({ operationId: 'op-reopen' }))
  assert.equal(reopened.operation.state, 'succeeded')

  releaseClose()
  const closed = await closePromise
  assert.equal(closed.operation.state, 'superseded')

  const stored = await store.inner.getBinding('binding-1')
  assert.equal(stored?.lastObservedDone, false)
  assert.equal(stored?.stateIntentVersion, reopened.operation.intentVersion)
})

test('supersede only marks close/reopen operations and leaves an unknown report reconcilable', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putBinding(binding({ bindingId: 'binding-1', stateIntentVersion: 1 }))
  client.set('createComment', async () => ({ kind: 'transport-error', cause: new Error('timeout') }))
  client.set('updateTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done: false }) }))
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done: false }) }))

  await service.appendReport(actor(), {
    operationId: 'op-report',
    bindingId: 'binding-1',
    actorMemberId: 'member-a',
    reportKind: 'status',
    body: 'progress',
  })
  await service.reopen(actor(), stateInput({ operationId: 'op-reopen' }))

  const report = await store.inner.getOperation({ workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-report' })
  assert.equal(report?.state, 'unknown')
  const listed = await service.listPendingWrites(actor(), 'ws-1')
  assert.ok(listed.some((item) => item.operation.operationRef.operationId === 'op-report'))
})
