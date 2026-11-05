import assert from 'node:assert/strict'
import test from 'node:test'
import { actor, binding, makeHarness, task } from '../support/harness.ts'

test('listForGoalTopFive keeps an expansion cursor beyond five items', async () => {
  const { service, store, client } = makeHarness()
  const ids = [10, 20, 30, 40, 50, 60]
  const priorities: Record<number, number> = { 10: 60, 20: 50, 30: 40, 40: 40, 50: 30, 60: 20 }
  for (const id of ids) {
    await store.inner.putBinding(binding({
      bindingId: `binding-${id}`,
      externalTaskId: id,
      lastObservedPriority: priorities[id],
      lastObservedDone: false,
      lastObservedAt: 0,
    }))
  }
  client.set('getTask', async (input) => ({ kind: 'ok', status: 200, value: task({ id: input.taskId, priority: priorities[input.taskId] }) }))
  const top = await service.listForGoalTopFive(actor(), 'ws-1', 'goal-1')
  assert.equal(top.items.length, 5)
  assert.ok(top.nextCursor)

  const all = await service.list(actor(), { workspaceId: 'ws-1', goalId: 'goal-1', status: 'open', limit: 10, cursor: top.nextCursor })
  assert.equal(all.items.length, 1)
  assert.equal(all.items[0]?.binding.externalTaskId, 60)
})
