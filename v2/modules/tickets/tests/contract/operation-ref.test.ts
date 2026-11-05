import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryBindingStore, SqliteBindingStore, TicketService } from '../../src/public/contracts.ts'
import {
  actor,
  createInput,
  FakeCredentials,
  FakeReaders,
  FakeVikunjaClient,
  makeHarness,
  makeService,
  NOW,
  providerInstance,
  task,
  workspaceProvider,
} from '../support/harness.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function withTempStore(run: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-store-'))
  try {
    await run(join(dir, 'tickets.sqlite'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the same operationId is independent across different actor accounts', async () => {
  const { service, store, client } = makeHarness()
  client.set('createTask', async (input) => {
    const id = input.title === 'A' ? 27 : 28
    return { kind: 'ok', status: 201, value: task({ id, title: input.title }) }
  })

  await service.create(actor('acct-a', 'member-a'), createInput({ operationId: 'op-1', title: 'A', ownerMemberId: 'member-a' }))
  await service.create(actor('acct-b', 'member-b'), createInput({ operationId: 'op-1', title: 'B', ownerMemberId: 'member-b' }))

  const operations = await store.inner.listOperations({ workspaceId: 'ws-1' })
  assert.equal(operations.length, 2)
  assert.equal(operations[0]?.operationRef.actorAccountId, 'acct-a')
  assert.equal(operations[1]?.operationRef.actorAccountId, 'acct-b')
  assert.equal(client.count('createTask'), 2)
})

test('the same account and operationId is independent across workspaces', async () => {
  const { service, store, client } = makeHarness()
  await store.inner.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-2', providerInstanceId: 'vk-1', externalProjectId: 40 }))
  client.set('createTask', async (input) => ({ kind: 'ok', status: 201, value: task({ id: input.projectId === 3 ? 27 : 40 }) }))

  await service.create(actor(), createInput({ operationId: 'op-1', workspaceId: 'ws-1' }))
  await service.create(actor(), createInput({ operationId: 'op-1', workspaceId: 'ws-2' }))

  assert.equal((await store.inner.listOperations({ workspaceId: 'ws-1' })).length, 1)
  assert.equal((await store.inner.listOperations({ workspaceId: 'ws-2' })).length, 1)
  assert.equal(client.count('createTask'), 2)
})

test('two services sharing one store allocate distinct binding ids and never overwrite', async () => {
  const store = new InMemoryBindingStore()
  await store.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-1' }))
  await store.putProviderInstance(providerInstance({ providerInstanceId: 'vk-1' }))
  const readers = new FakeReaders()
  const credentials = new FakeCredentials()
  const client = new FakeVikunjaClient()
  client.set('createTask', async (input) => ({ kind: 'ok', status: 201, value: task({ id: input.title === 'A' ? 101 : 102, title: input.title }) }))
  const serviceA = new TicketService({ store, credentials, client, readers, now: () => NOW })
  const serviceB = new TicketService({ store, credentials, client, readers, now: () => NOW })

  const first = await serviceA.create(actor(), createInput({ operationId: 'op-a', title: 'A' }))
  const second = await serviceB.create(actor(), createInput({ operationId: 'op-b', title: 'B' }))

  assert.ok(first.binding && second.binding)
  assert.notEqual(first.binding?.bindingId, second.binding?.bindingId)
  const keptFirst = await store.getBinding(first.binding!.bindingId)
  const keptSecond = await store.getBinding(second.binding!.bindingId)
  assert.equal(keptFirst?.externalTaskId, 101)
  assert.equal(keptSecond?.externalTaskId, 102)
})

test('two workspaces sharing one store do not overwrite each other bindings', async () => {
  const store = new InMemoryBindingStore()
  await store.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-1', externalProjectId: 3 }))
  await store.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-2', externalProjectId: 40 }))
  await store.putProviderInstance(providerInstance({ providerInstanceId: 'vk-1' }))
  const readers = new FakeReaders()
  const credentials = new FakeCredentials()
  const client = new FakeVikunjaClient()
  client.set('createTask', async (input) => ({ kind: 'ok', status: 201, value: task({ id: input.projectId === 3 ? 201 : 202, project_id: input.projectId }) }))
  const service = new TicketService({ store, credentials, client, readers, now: () => NOW })

  const first = await service.create(actor(), createInput({ operationId: 'op-1', workspaceId: 'ws-1' }))
  const second = await service.create(actor(), createInput({ operationId: 'op-1', workspaceId: 'ws-2' }))

  assert.ok(first.binding && second.binding)
  assert.notEqual(first.binding?.bindingId, second.binding?.bindingId)
  assert.equal((await store.getBinding(first.binding!.bindingId))?.externalTaskId, 201)
  assert.equal((await store.getBinding(second.binding!.bindingId))?.externalTaskId, 202)
  assert.equal((await store.listBindings({ workspaceId: 'ws-1' })).length, 1)
  assert.equal((await store.listBindings({ workspaceId: 'ws-2' })).length, 1)
})

test('a sequential service rebuild over the same store keeps an unknown operation reconcilable', async () => {
  const { service, store, client } = makeHarness()
  client.set('createTask', async () => ({ kind: 'ok', status: 201, value: null }))
  await service.create(actor(), createInput({ operationId: 'op-1' }))

  const rebuildClient = new FakeVikunjaClient()
  const rebuilt = makeService({ store: store.inner, client: rebuildClient })
  const pending = await rebuilt.listPendingWrites(actor(), 'ws-1')
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.operation.state, 'unknown')
  assert.equal(rebuildClient.count('createTask'), 0)
  assert.equal(client.count('createTask'), 1)
  const replay = await rebuilt.create(actor(), createInput({ operationId: 'op-1' }))
  assert.equal(replay.operation.state, 'unknown')
  assert.equal(rebuildClient.count('createTask'), 0)
})

test('the SQLite store continues its binding sequence after a real reload', async () => {
  await withTempStore(async (dbPath) => {
    const first = new SqliteBindingStore({ path: dbPath })
    await first.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-1' }))
    await first.putProviderInstance(providerInstance({ providerInstanceId: 'vk-1' }))
    const readers = new FakeReaders()
    const credentials = new FakeCredentials()
    const client = new FakeVikunjaClient()
    client.set('createTask', async (input) => ({ kind: 'ok', status: 201, value: task({ id: input.title === 'A' ? 301 : 302, title: input.title }) }))
    const service = new TicketService({ store: first, credentials, client, readers, now: () => NOW })
    const created = await service.create(actor(), createInput({ operationId: 'op-1', title: 'A' }))
    assert.equal(created.binding?.bindingId, 'binding-1')
    first.close()

    const reopened = new SqliteBindingStore({ path: dbPath })
    assert.equal((await reopened.getBinding('binding-1'))?.externalTaskId, 301)
    assert.equal(await reopened.allocateBindingId(), 'binding-2')
    assert.equal(await reopened.allocateBindingId(), 'binding-3')
    reopened.close()
  })
})
