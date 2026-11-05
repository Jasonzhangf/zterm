import assert from 'node:assert/strict'
import test from 'node:test'
import { actor, appendInput, binding, makeHarness, stateInput, task } from '../support/harness.ts'

test('a newer reopen supersedes an older unknown close and does not re-PATCH it', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putBinding(binding({ bindingId: 'binding-1', stateIntentVersion: 0 }))

  let done = false
  client.set('updateTask', async (input) => {
    if (input.patch.done === true) {
      return { kind: 'transport-error', cause: new Error('timeout') }
    }
    done = false
    return { kind: 'ok', status: 200, value: task({ id: 27, done }) }
  })
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done }) }))

  const closed = await service.close(actor(), stateInput({ operationId: 'op-close' }))
  assert.equal(closed.operation.state, 'unknown')
  const closeVersion = closed.operation.intentVersion
  assert.equal(typeof closeVersion, 'number')

  const reopened = await service.reopen(actor(), stateInput({ operationId: 'op-reopen' }))
  assert.equal(reopened.operation.state, 'succeeded')
  assert.ok((reopened.operation.intentVersion ?? 0) > (closeVersion ?? 0))

  const old = await store.inner.getOperation({ workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-close' })
  assert.equal(old?.state, 'superseded')
  // Only the close and the reopen PATCH reached the provider; the old close was not re-sent.
  assert.equal(client.count('updateTask'), 2)
})

test('a controllable-delay old close cannot overwrite a completed newer reopen', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putBinding(binding({ bindingId: 'binding-1', stateIntentVersion: 0 }))

  let done = false
  let closeStarted!: () => void
  const closeStartedP = new Promise<void>((resolve) => {
    closeStarted = resolve
  })
  let releaseClose!: () => void
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve
  })

  client.set('updateTask', async (input) => {
    if (input.patch.done === true) {
      closeStarted()
      await closeGate
      done = true
      return { kind: 'ok', status: 200, value: task({ id: 27, done: true }) }
    }
    done = false
    return { kind: 'ok', status: 200, value: task({ id: 27, done }) }
  })
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done }) }))

  const closePromise = service.close(actor(), stateInput({ operationId: 'op-close' }))
  await closeStartedP

  const reopened = await service.reopen(actor(), stateInput({ operationId: 'op-reopen' }))
  assert.equal(reopened.operation.state, 'succeeded')
  assert.equal(reopened.operation.intentVersion, 2)

  releaseClose()
  const lateClose = await closePromise
  assert.equal(lateClose.operation.state, 'superseded')
  assert.equal(lateClose.operation.intentVersion, 1)

  const reopenOp = await store.inner.getOperation({ workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-reopen' })
  assert.equal(reopenOp?.state, 'succeeded')
  const closeOp = await store.inner.getOperation({ workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-close' })
  assert.equal(closeOp?.state, 'superseded')
  // The late close is observable in the provider but the local commit refused it.
  const observed = await service.get(actor(), { bindingId: 'binding-1' })
  assert.equal(observed.ticket?.done, true)
  assert.equal(client.count('updateTask'), 2)
})

test('an unknown appendReport is not superseded by a newer state operation and stays reconcilable', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putBinding(binding({ bindingId: 'binding-1', stateIntentVersion: 0 }))

  client.set('createComment', async () => ({ kind: 'transport-error', cause: new Error('timeout') }))
  let done = false
  client.set('updateTask', async () => {
    done = true
    return { kind: 'ok', status: 200, value: task({ id: 27, done: true }) }
  })
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done }) }))

  const report = await service.appendReport(actor(), appendInput({ operationId: 'op-report' }))
  assert.equal(report.operation.state, 'unknown')

  const closed = await service.close(actor(), stateInput({ operationId: 'op-close' }))
  assert.equal(closed.operation.state, 'succeeded')

  const reportOp = await store.inner.getOperation({ workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-report' })
  assert.equal(reportOp?.state, 'unknown')
  const pending = await service.listPendingWrites(actor(), 'ws-1')
  assert.deepEqual(
    pending.map((item) => item.operation.operationRef.operationId).sort(),
    ['op-report'],
  )
})

test('a late provider state change is observable but the local adapter does not claim fencing', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putBinding(binding({ bindingId: 'binding-1', stateIntentVersion: 0 }))

  client.set('updateTask', async () => ({ kind: 'transport-error', cause: new Error('timeout') }))
  await service.close(actor(), stateInput({ operationId: 'op-close' }))

  client.set('updateTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done: false }) }))
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done: false }) }))
  await service.reopen(actor(), stateInput({ operationId: 'op-reopen' }))

  // The late old PATCH lands after the reopen: provider observation is now done=true.
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done: true }) }))
  const observation = await service.get(actor(), { bindingId: 'binding-1' })
  assert.equal(observation.ticket?.done, true)
  assert.equal(observation.freshness, 'fresh')

  const old = await store.inner.getOperation({ workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-close' })
  assert.equal(old?.state, 'superseded')
})
