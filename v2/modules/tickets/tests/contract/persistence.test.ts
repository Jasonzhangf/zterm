import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SqliteBindingStore, TicketService } from '../../src/public/contracts.ts'
import {
  actor,
  createInput,
  FakeCredentials,
  FakeReaders,
  FakeVikunjaClient,
  providerInstance,
  task,
  workspaceProvider,
} from '../support/harness.ts'

const execFileAsync = promisify(execFile)

test('a real new process does not re-POST a same-ref unknown create after response loss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-'))
  const dbPath = join(dir, 'tickets.sqlite')
  try {
    const store = new SqliteBindingStore({ path: dbPath })
    await store.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-1', externalProjectId: 3 }))
    await store.putProviderInstance(providerInstance({ providerInstanceId: 'vk-1' }))
    const client = new FakeVikunjaClient()
    client.set('createTask', async () => ({ kind: 'ok', status: 201, value: null }))
    const service = new TicketService({
      store,
      client,
      readers: new FakeReaders(),
      credentials: new FakeCredentials(),
      now: () => Date.UTC(2026, 10, 3, 5, 0, 0),
    })
    const created = await service.create(actor(), createInput({ operationId: 'op-restart-1' }))
    assert.equal(created.operation.state, 'unknown')
    assert.equal(client.count('createTask'), 1)
    store.close()

    const child = fileURLToPath(new URL('../support/restart-child.ts', import.meta.url))
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', child, 'replay', dbPath])
    const result = JSON.parse(stdout.trim()) as { createCalls: number; state: string; operationRef: { operationId: string } }
    assert.equal(result.createCalls, 0)
    assert.equal(result.state, 'unknown')
    assert.equal(result.operationRef.operationId, 'op-restart-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('two services sharing one durable store allocate unique binding IDs across two workspaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-'))
  const dbPath = join(dir, 'tickets.sqlite')
  try {
    const store = new SqliteBindingStore({ path: dbPath })
    await store.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-1', externalProjectId: 3 }))
    await store.putWorkspaceProvider(workspaceProvider({ workspaceId: 'ws-2', externalProjectId: 40 }))
    await store.putProviderInstance(providerInstance({ providerInstanceId: 'vk-1' }))

    let providerSequence = 100
    function service() {
      const client = new FakeVikunjaClient()
      client.set('createTask', async () => ({ kind: 'ok', status: 201, value: task({ id: ++providerSequence }) }))
      return {
        client,
        service: new TicketService({
          store,
          client,
          readers: new FakeReaders(),
          credentials: new FakeCredentials(),
          now: () => Date.UTC(2026, 10, 3, 5, 0, 0),
        }),
      }
    }

    const a = service()
    const b = service()
    const first = await a.service.create(actor(), createInput({ operationId: 'op-a', workspaceId: 'ws-1' }))
    const second = await b.service.create(actor(), createInput({ operationId: 'op-b', workspaceId: 'ws-2' }))

    assert.ok(first.binding?.bindingId)
    assert.ok(second.binding?.bindingId)
    assert.notEqual(first.binding?.bindingId, second.binding?.bindingId)
    assert.equal((await store.getBinding(first.binding?.bindingId as string))?.workspaceId, 'ws-1')
    assert.equal((await store.getBinding(second.binding?.bindingId as string))?.workspaceId, 'ws-2')

    const third = await a.service.create(actor(), createInput({ operationId: 'op-c', workspaceId: 'ws-1' }))
    assert.ok(third.binding?.bindingId)
    assert.notEqual(third.binding?.bindingId, first.binding?.bindingId)
    assert.equal((await store.getBinding(first.binding?.bindingId as string))?.externalTaskId, 101)
    assert.equal((await store.getBinding(second.binding?.bindingId as string))?.externalTaskId, 102)
    assert.equal((await store.getBinding(third.binding?.bindingId as string))?.externalTaskId, 103)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
