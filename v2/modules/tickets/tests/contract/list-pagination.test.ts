import assert from 'node:assert/strict'
import test from 'node:test'
import { actor, binding, makeHarness, task } from '../support/harness.ts'

test('list continues a top-five cursor through every remaining page', async () => {
  const { service, store, client } = makeHarness()
  const ids = Array.from({ length: 12 }, (_, index) => (index + 1) * 10)
  const priorities = Object.fromEntries(ids.map((id) => [id, 120 - id]))
  for (const id of ids) {
    await store.inner.putBinding(binding({
      bindingId: `binding-${id}`,
      externalTaskId: id,
      lastObservedPriority: priorities[id],
      lastObservedDone: false,
      lastObservedAt: 0,
    }))
  }
  client.set('getTask', async (input) => ({
    kind: 'ok',
    status: 200,
    value: task({ id: input.taskId, priority: priorities[input.taskId] }),
  }))

  const top = await service.listForGoalTopFive(actor(), 'ws-1', 'goal-1')
  assert.equal(top.items.length, 5)
  assert.ok(top.nextCursor)

  const second = await service.list(actor(), {
    workspaceId: 'ws-1',
    goalId: 'goal-1',
    status: 'open',
    limit: 5,
    cursor: top.nextCursor,
  })
  assert.deepEqual(second.items.map((item) => item.binding.externalTaskId), [60, 70, 80, 90, 100])
  assert.ok(second.nextCursor)

  const third = await service.list(actor(), {
    workspaceId: 'ws-1',
    goalId: 'goal-1',
    status: 'open',
    limit: 5,
    cursor: second.nextCursor,
  })
  assert.deepEqual(third.items.map((item) => item.binding.externalTaskId), [110, 120])
  assert.equal(third.nextCursor, undefined)
})
