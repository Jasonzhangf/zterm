import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actor,
  appendInput,
  binding,
  confirmInput,
  createInput,
  expectTicketError,
  makeHarness,
  task,
} from '../support/harness.ts'

test('listPendingWrites denies without a current read scope before any store read', async () => {
  const { service, store, client, readers } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: null }))
  await service.create(actor(), createInput({ operationId: 'op-create-1' }))
  const before = store.total
  readers.deniedActions.add('ticket.read')
  readers.deniedActions.add('ticket.operation.reconcile')

  await assert.rejects(service.listPendingWrites(actor(), 'ws-1'), expectTicketError('TICKET_SCOPE_FORBIDDEN'))
  assert.equal(store.total, before)
})

test('listPendingWrites returns own unknown writes for a readable non-reconciler', async () => {
  const { service, client } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: null }))
  await service.create(actor(), createInput({ operationId: 'op-create-1' }))

  const pending = await service.listPendingWrites(actor(), 'ws-1')
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.operation.state, 'unknown')
  assert.equal(pending[0]?.canReconcile, true)
})

test('confirmRemoteResult refuses to re-bind a succeeded create', async () => {
  const { service, client } = makeHarness()
  client.set('createTask', async (input) => ({ kind: 'ok', status: 201, value: task({ id: input.title === 'second' ? 40 : 27, project_id: 3 }) }))
  await service.create(actor(), createInput())
  client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 40, project_id: 3 }) }))

  await assert.rejects(
    service.confirmRemoteResult(actor(), confirmInput({ candidateExternalTaskId: 40, evidenceRef: 'evidence://manual/2' })),
    expectTicketError('OPERATION_CONFLICT'),
  )
})

test('a comment already claimed by another operation cannot be re-claimed', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putBinding(binding({ bindingId: 'binding-1' }))
  client.set('createComment', async () => ({ kind: 'ok', status: 201, value: { id: 8, comment: 'body', created: 'x', author: { id: 1 } } }))
  await service.appendReport(actor(), appendInput({ operationId: 'op-report-a' }))

  await store.inner.putOperation({
    operationRef: { workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-report-b' },
    bindingId: 'binding-1',
    kind: 'appendReport',
    request: { kind: 'appendReport', bindingId: 'binding-1', actorMemberId: 'member-a', reportKind: 'note', body: 'other' },
    state: 'unknown',
    resolution: 'none',
  })
  client.set('listComments', async () => ({ kind: 'ok', status: 200, value: [{ id: 8, comment: 'body', created: 'x', author: { id: 1 } }] }))

  await assert.rejects(
    service.confirmRemoteResult(
      actor(),
      confirmInput({
        operationRef: { workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-report-b' },
        candidateExternalCommentId: 8,
        evidenceRef: 'evidence://manual/2',
      }),
    ),
    expectTicketError('BINDING_CONFLICT'),
  )
})
