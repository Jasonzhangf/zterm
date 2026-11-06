import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  InMemoryBindingStore,
  SqliteBindingStore,
  TicketService,
  type BindingStorePort,
  type OperationRef,
  type WriteOperation,
} from '../../src/public/contracts.ts'
import {
  actor,
  createInput,
  expectTicketError,
  FakeCredentials,
  FakeReaders,
  FakeVikunjaClient,
  NOW,
  providerInstance,
  task,
  workspaceProvider,
} from '../support/harness.ts'

const CREATE_REF: OperationRef = { workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-create-1' }

function pendingCreate(leaseUntil: number): WriteOperation {
  return {
    operationRef: CREATE_REF,
    kind: 'create',
    request: {
      kind: 'create',
      workspaceId: 'ws-1',
      goalId: 'goal-1',
      ownerMemberId: 'member-a',
      category: 'requirement',
      title: 'Fix login',
      description: 'body',
      priority: 10,
    },
    state: 'pending',
    providerInstanceId: 'vk-1',
    externalProjectId: 3,
    resolution: 'none',
    executionLeaseOwner: 'tickets-op-create-1',
    executionLeaseUntil: leaseUntil,
  }
}

function makeService(store: BindingStorePort, client: FakeVikunjaClient, now: number): TicketService {
  return new TicketService({
    store,
    client,
    readers: new FakeReaders(),
    credentials: new FakeCredentials(),
    now: () => now,
  })
}

async function seedCreateContext(store: BindingStorePort): Promise<void> {
  await store.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-1', providerInstanceId: 'vk-1', externalProjectId: 3 }))
  await store.putProviderInstance(providerInstance({ providerInstanceId: 'vk-1' }))
}

async function withStores(run: (store: BindingStorePort) => Promise<void>): Promise<void> {
  await run(new InMemoryBindingStore())
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-recovery-'))
  const store = new SqliteBindingStore({ path: join(dir, 'tickets.sqlite') })
  try {
    await run(store)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('recovery leaves a pending write with a still-valid lease untouched', async () => {
  await withStores(async (store) => {
    await store.putOperation(pendingCreate(NOW + 30_000))
    const recovered = await store.recoverExpiredPending(CREATE_REF, NOW)
    assert.equal(recovered?.state, 'pending')
    assert.equal((await store.getOperation(CREATE_REF))?.state, 'pending')
  })
})

test('recovery turns an expired pending write into unknown without guessing success', async () => {
  await withStores(async (store) => {
    await store.putOperation(pendingCreate(NOW - 1))
    const recovered = await store.recoverExpiredPending(CREATE_REF, NOW)
    assert.equal(recovered?.state, 'unknown')
    assert.equal(recovered?.errorCode, 'WRITE_OUTCOME_UNKNOWN')
    assert.equal(recovered?.successSource, undefined)
    assert.equal((await store.getOperation(CREATE_REF))?.state, 'unknown')
  })
})

test('recovery never rewrites an already succeeded operation', async () => {
  await withStores(async (store) => {
    const succeeded: WriteOperation = {
      ...pendingCreate(NOW - 1),
      operationRef: { ...CREATE_REF, operationId: 'op-succeeded' },
      state: 'succeeded',
      externalTaskId: 99,
      resolution: 'auto-verified',
      successSource: 'provider',
    }
    await store.putOperation(succeeded)
    const recovered = await store.recoverExpiredPending(succeeded.operationRef, NOW)
    assert.deepEqual(recovered, succeeded)
  })
})

test('a stale pending create replays as unknown, never re-posts, and can then be manually confirmed', async () => {
  await withStores(async (store) => {
    await seedCreateContext(store)
    await store.putOperation(pendingCreate(NOW - 1))
    const client = new FakeVikunjaClient()
    client.set('createTask', async () => {
      throw new Error('createTask must not run during recovery')
    })
    client.set('getTask', async () => ({ kind: 'ok', status: 200, value: task({ id: 30, title: 'Fix login', priority: 10 }) }))
    const service = makeService(store, client, NOW)

    const replay = await service.create(actor(), createInput())
    assert.equal(replay.operation.state, 'unknown')
    assert.equal(replay.operation.retryDisposition, 'manual-reconciliation')
    assert.equal(client.count('createTask'), 0)
    assert.equal((await store.getOperation(CREATE_REF))?.state, 'unknown')

    const confirmed = await service.confirmRemoteResult(actor(), {
      operationRef: CREATE_REF,
      candidateExternalTaskId: 30,
      providerObservedAt: NOW,
      evidenceRef: 'evidence://manual/recovery',
      attribution: 'operation-produced',
    })
    assert.equal(confirmed.operation.state, 'succeeded')
    assert.equal(confirmed.operation.successSource, 'manual')
    assert.equal(confirmed.operation.resolution, 'manually-verified')
  })
})

test('manual reconciliation cannot preempt a pending executor whose lease is still valid', async () => {
  await withStores(async (store) => {
    await seedCreateContext(store)
    await store.putOperation(pendingCreate(NOW + 30_000))
    const client = new FakeVikunjaClient()
    const service = makeService(store, client, NOW)

    await assert.rejects(
      service.confirmRemoteResult(actor(), {
        operationRef: CREATE_REF,
        candidateExternalTaskId: 30,
        providerObservedAt: NOW,
        evidenceRef: 'evidence://manual/live-lease',
        attribution: 'operation-produced',
      }),
      expectTicketError('OPERATION_CONFLICT'),
    )
    assert.equal((await store.getOperation(CREATE_REF))?.state, 'pending')
    assert.equal(client.count('createTask'), 0)
  })
})

test('a stale pending appendReport replays as unknown without re-posting the comment', async () => {
  await withStores(async (store) => {
    const reportRef: OperationRef = { workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-report-1' }
    await store.putBinding({
      bindingId: 'binding-1',
      workspaceId: 'ws-1',
      goalId: 'goal-1',
      ownerMemberId: 'member-a',
      providerInstanceId: 'vk-1',
      externalProjectId: 3,
      externalTaskId: 27,
      category: 'requirement',
      stateIntentVersion: 0,
    })
    await store.putOperation({
      operationRef: reportRef,
      bindingId: 'binding-1',
      kind: 'appendReport',
      request: {
        kind: 'appendReport',
        bindingId: 'binding-1',
        actorMemberId: 'member-a',
        reportKind: 'status',
        body: 'progress',
      },
      state: 'pending',
      providerInstanceId: 'vk-1',
      externalProjectId: 3,
      resolution: 'none',
      executionLeaseOwner: 'tickets-op-report-1',
      executionLeaseUntil: NOW - 1,
    })
    const client = new FakeVikunjaClient()
    client.set('createComment', async () => {
      throw new Error('createComment must not run during recovery')
    })
    const service = makeService(store, client, NOW)

    const result = await service.appendReport(actor(), {
      operationId: 'op-report-1',
      bindingId: 'binding-1',
      actorMemberId: 'member-a',
      reportKind: 'status',
      body: 'progress',
    })
    assert.equal(result.operation.state, 'unknown')
    assert.equal(result.operation.retryDisposition, 'manual-reconciliation')
    assert.equal(client.count('createComment'), 0)
    assert.equal((await store.getOperation(reportRef))?.state, 'unknown')
  })
})
