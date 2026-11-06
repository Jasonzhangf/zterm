import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteBindingStore, TicketService } from '../../src/public/contracts.ts'
import {
  actor,
  appendInput,
  binding,
  FakeCredentials,
  FakeReaders,
  FakeVikunjaClient,
  NOW,
  providerInstance,
  stateInput,
  task,
  workspaceProvider,
} from '../support/harness.ts'

test('a SQLite reopen supersedes a NUL-separated close key across a reopened database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-supersede-nul-'))
  const dbPath = join(dir, 'tickets.sqlite')
  try {
    let store = new SqliteBindingStore({ path: dbPath })
    await store.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-1' }))
    await store.putProviderInstance(providerInstance({ providerInstanceId: 'vk-1' }))
    await store.putBinding(binding({ bindingId: 'binding-1', stateIntentVersion: 0 }))

    const client = new FakeVikunjaClient()
    client.set('createComment', async () => ({ kind: 'transport-error', cause: new Error('timeout') }))
    client.set('updateTask', async (input) => {
      if (input.patch.done === true) {
        return { kind: 'transport-error', cause: new Error('timeout') }
      }
      return { kind: 'ok', status: 200, value: task({ id: 27, done: false }) }
    })
    client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 27, done: false }) }))

    const readers = new FakeReaders()
    const credentials = new FakeCredentials()
    const service = new TicketService({
      store,
      client,
      readers,
      credentials,
      now: () => NOW,
    })

    const report = await service.appendReport(actor(), appendInput({ operationId: 'op-report' }))
    assert.equal(report.operation.state, 'unknown')
    const closed = await service.close(actor(), stateInput({ operationId: 'op-close' }))
    assert.equal(closed.operation.state, 'unknown')
    const oldClose = await store.getOperation({
      workspaceId: 'ws-1',
      actorAccountId: 'acct-a',
      operationId: 'op-close',
    })
    assert.equal(oldClose?.state, 'unknown')

    const reopened = await service.reopen(actor(), stateInput({ operationId: 'op-reopen' }))
    assert.equal(reopened.operation.state, 'succeeded')
    assert.equal(
      (
        await store.getOperation({
          workspaceId: 'ws-1',
          actorAccountId: 'acct-a',
          operationId: 'op-reopen',
        })
      )?.state,
      'succeeded',
    )

    assert.equal(
      (
        await store.getOperation({
          workspaceId: 'ws-1',
          actorAccountId: 'acct-a',
          operationId: 'op-close',
        })
      )?.state,
      'superseded',
    )
    const pending = await store.listPendingWrites({ workspaceId: 'ws-1', states: ['pending', 'unknown'] })
    assert.equal(pending.some((operation) => operation.operationRef.operationId === 'op-close'), false)
    const superseded = await store.listPendingWrites({ workspaceId: 'ws-1', states: ['superseded'] })
    assert.equal(superseded.some((operation) => operation.operationRef.operationId === 'op-close'), true)
    assert.equal(
      (
        await store.getOperation({
          workspaceId: 'ws-1',
          actorAccountId: 'acct-a',
          operationId: 'op-report',
        })
      )?.state,
      'unknown',
    )

    // Public service projection: a superseded old intent must stay in history
    // but never be offered as executable/reconcilable, while an unknown
    // appendReport keeps the existing reconcile rule. Listing must not post.
    const createCommentPosts = client.count('createComment')
    const updateTaskPosts = client.count('updateTask')
    const reconcilerPending = await service.listPendingWrites(actor(), 'ws-1')
    const supersededItem = reconcilerPending.find(
      (item) => item.operation.operationRef.operationId === 'op-close',
    )
    const reportItem = reconcilerPending.find(
      (item) => item.operation.operationRef.operationId === 'op-report',
    )
    assert.equal(supersededItem?.operation.state, 'superseded')
    assert.equal(supersededItem?.canReconcile, false)
    assert.equal(reportItem?.operation.state, 'unknown')
    assert.equal(reportItem?.canReconcile, true)
    assert.equal(client.count('createComment'), createCommentPosts)
    assert.equal(client.count('updateTask'), updateTaskPosts)

    // A caller without the reconcile action cannot flip superseded or unknown
    // items to reconcile-able true.
    const deniedReaders = new FakeReaders()
    deniedReaders.deniedActions.add('ticket.operation.reconcile')
    const deniedService = new TicketService({
      store,
      client,
      readers: deniedReaders,
      credentials,
      now: () => NOW,
    })
    const deniedPending = await deniedService.listPendingWrites(actor(), 'ws-1')
    assert.equal(
      deniedPending.find((item) => item.operation.operationRef.operationId === 'op-close')?.canReconcile,
      false,
    )
    assert.equal(
      deniedPending.find((item) => item.operation.operationRef.operationId === 'op-report')?.canReconcile,
      false,
    )

    assert.ok(oldClose)
    const lateCommit = await store.commitWriteSuccess(oldClose)
    assert.equal(lateCommit.committed, false)
    assert.equal(lateCommit.conflict, 'intent-superseded')
    assert.equal(lateCommit.operation?.state, 'superseded')

    store.close()
    store = new SqliteBindingStore({ path: dbPath })
    assert.equal(
      (
        await store.getOperation({
          workspaceId: 'ws-1',
          actorAccountId: 'acct-a',
          operationId: 'op-close',
        })
      )?.state,
      'superseded',
    )

    // Reopening the database and rebuilding the read service keeps the same
    // projection: superseded stays non-reconcilable, appendReport keeps its
    // rule, and listing still issues no provider POST.
    const reopenedService = new TicketService({
      store,
      client,
      readers,
      credentials,
      now: () => NOW,
    })
    const reopenedListSnapshot = {
      comments: client.count('createComment'),
      updates: client.count('updateTask'),
    }
    const reopenedPending = await reopenedService.listPendingWrites(actor(), 'ws-1')
    const reopenedClosing = reopenedPending.find(
      (item) => item.operation.operationRef.operationId === 'op-close',
    )
    const reopenedReport = reopenedPending.find(
      (item) => item.operation.operationRef.operationId === 'op-report',
    )
    assert.equal(reopenedClosing?.operation.state, 'superseded')
    assert.equal(reopenedClosing?.canReconcile, false)
    assert.equal(reopenedReport?.operation.state, 'unknown')
    assert.equal(reopenedReport?.canReconcile, true)
    assert.equal(client.count('createComment'), reopenedListSnapshot.comments)
    assert.equal(client.count('updateTask'), reopenedListSnapshot.updates)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
