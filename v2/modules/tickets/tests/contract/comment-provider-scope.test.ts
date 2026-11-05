import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  InMemoryBindingStore,
  SqliteBindingStore,
  TicketService,
  type BindingStorePort,
} from '../../src/public/contracts.ts'
import {
  actor,
  appendInput,
  binding,
  expectTicketError,
  FakeCredentials,
  FakeReaders,
  FakeVikunjaClient,
  NOW,
  providerInstance,
} from '../support/harness.ts'

const COMMENT_ID = 5

function serviceFor(store: BindingStorePort, client: FakeVikunjaClient): TicketService {
  return new TicketService({
    store,
    client,
    readers: new FakeReaders(),
    credentials: new FakeCredentials(),
    now: () => NOW,
  })
}

function clientReturningComment(id: number): FakeVikunjaClient {
  const client = new FakeVikunjaClient()
  client.set('createComment', async () => ({
    kind: 'ok',
    status: 201,
    value: { id, comment: 'body', created: '2026-11-03T05:00:00Z', author: { id: 1 } },
  }))
  return client
}

async function seedTwoProviderBindings(store: BindingStorePort): Promise<void> {
  await store.putProviderInstance(providerInstance({ providerInstanceId: 'vk-1' }))
  await store.putProviderInstance(providerInstance({ providerInstanceId: 'vk-2' }))
  await store.putBinding(binding({ bindingId: 'binding-1', providerInstanceId: 'vk-1', externalTaskId: 27 }))
  await store.putBinding(binding({ bindingId: 'binding-2', providerInstanceId: 'vk-2', externalTaskId: 28 }))
}

async function withStores(run: (store: BindingStorePort) => Promise<void>): Promise<void> {
  await run(new InMemoryBindingStore())
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-comment-'))
  const store = new SqliteBindingStore({ path: join(dir, 'tickets.sqlite') })
  try {
    await run(store)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('two providers may own the same numeric comment id and each claim stays queryable', async () => {
  await withStores(async (store) => {
    await seedTwoProviderBindings(store)
    const client = clientReturningComment(COMMENT_ID)
    const service = serviceFor(store, client)

    const first = await service.appendReport(actor(), appendInput({ operationId: 'op-a', bindingId: 'binding-1' }))
    const second = await service.appendReport(actor(), appendInput({ operationId: 'op-b', bindingId: 'binding-2' }))

    assert.equal(first.operation.state, 'succeeded')
    assert.equal(second.operation.state, 'succeeded')
    assert.equal(second.operation.externalCommentId, COMMENT_ID)
    assert.equal(client.count('createComment'), 2)

    const firstClaim = await store.getOperationByExternalComment('vk-1', COMMENT_ID)
    const secondClaim = await store.getOperationByExternalComment('vk-2', COMMENT_ID)
    assert.equal(firstClaim?.operationRef.operationId, 'op-a')
    assert.equal(secondClaim?.operationRef.operationId, 'op-b')
  })
})

test('a single provider cannot hand the same numeric comment id to a second operation', async () => {
  await withStores(async (store) => {
    await store.putProviderInstance(providerInstance({ providerInstanceId: 'vk-1' }))
    await store.putBinding(binding({ bindingId: 'binding-1', providerInstanceId: 'vk-1', externalTaskId: 27 }))
    const client = clientReturningComment(COMMENT_ID)
    const service = serviceFor(store, client)

    const first = await service.appendReport(actor(), appendInput({ operationId: 'op-a', bindingId: 'binding-1' }))
    assert.equal(first.operation.state, 'succeeded')

    await assert.rejects(
      service.appendReport(actor(), appendInput({ operationId: 'op-b', bindingId: 'binding-1' })),
      expectTicketError('BINDING_CONFLICT'),
    )
    const claim = await store.getOperationByExternalComment('vk-1', COMMENT_ID)
    assert.equal(claim?.operationRef.operationId, 'op-a')
    const second = await store.getOperation({ workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-b' })
    assert.equal(second?.state, 'pending')
  })
})

test('reopening an existing candidate database drops the legacy global comment index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-reopen-'))
  const path = join(dir, 'tickets.sqlite')
  try {
    const legacy = new SqliteBindingStore({ path })
    legacy.close()
    const raw = new DatabaseSync(path)
    raw.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS operations_comment_unique ON operations(external_comment_id) WHERE external_comment_id IS NOT NULL;",
    )
    raw.close()

    const store = new SqliteBindingStore({ path })
    try {
      const probe = new DatabaseSync(path)
      const index = probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'operations_comment_unique'")
        .get()
      probe.close()
      assert.equal(index, undefined)

      await seedTwoProviderBindings(store)
      const client = clientReturningComment(COMMENT_ID)
      const service = serviceFor(store, client)
      const first = await service.appendReport(actor(), appendInput({ operationId: 'op-a', bindingId: 'binding-1' }))
      const second = await service.appendReport(actor(), appendInput({ operationId: 'op-b', bindingId: 'binding-2' }))
      assert.equal(first.operation.state, 'succeeded')
      assert.equal(second.operation.state, 'succeeded')
    } finally {
      store.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
